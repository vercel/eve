import { afterEach, describe, expect, it, vi } from "vitest";
import { start } from "#internal/workflow/runtime.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import type { TestRuntime } from "#internal/testing/app-harness.js";
import {
  backgroundDeployWorkflow,
  confirmDeployWorkflow,
  failingDeployWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import type { InputRequestedStreamEvent } from "#protocol/message.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";

describe("background workflow tools", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("runs a session-owned background workflow invocation", async () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-background",
      execute: backgroundDeployWorkflow,
      toolName: "report_deploy",
    });

    await runtime.run(async () => {
      enableBackgroundTool(runtime, "report_deploy");

      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run report_deploy with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            acceptedDeploymentId: "dpl_inline",
            continuationToken: "http:workflow-tool-background",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const receiptTurn = await stream.nextTurn();
        const receipt = filterEventsByType(receiptTurn, "action.result").find(
          (event) => event.data.result.kind === "tool-result",
        );
        expect(receipt?.data.result.output).toMatchObject({ status: "working" });
        expect(filterEventsByType(receiptTurn, "turn.failed")).toHaveLength(0);

        const notifications: string[] = [];
        for (
          let turn = 0;
          turn < 3 && !notifications.some((text) => text.includes("is completed"));
          turn += 1
        ) {
          const woken = await stream.nextTurn();
          expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
          notifications.push(eventsText(filterEventsByType(woken, "message.received")));
        }
        const text = notifications.join("\n");
        expect(text).not.toContain("Review plan:api");
        expect(text).not.toContain("update: planned api");
        expect(text).toContain("is completed");
        expect(text).toContain("plan:api");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 90_000);

  it("wakes the agent with the failure when a background workflow tool throws", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-background-fail",
      execute: failingDeployWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      enableBackgroundTool(runtime, "deploy_service");

      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-background-fail",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const receiptTurn = await stream.nextTurn();
        expect(filterEventsByType(receiptTurn, "turn.failed")).toHaveLength(0);

        const notifications: string[] = [];
        for (
          let turn = 0;
          turn < 3 && !notifications.some((t) => t.includes("failed"));
          turn += 1
        ) {
          const woken = await stream.nextTurn();
          expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
          notifications.push(eventsText(filterEventsByType(woken, "message.received")));
        }
        const text = notifications.join("\n");
        expect(text).toContain("(deploy_service) failed.");
        expect(text).toContain("deploy of api exploded");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 90_000);

  it("lets a background workflow tool ask now and act when answered", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-background-hitl",
      execute: confirmDeployWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      enableBackgroundTool(runtime, "confirm_deploy");

      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-background-hitl",
            mode: "conversation",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const receiptTurn = await stream.nextTurn();
        expect(filterEventsByType(receiptTurn, "turn.failed")).toHaveLength(0);
        expect(
          filterEventsByType(receiptTurn, "action.result").some(
            (event) =>
              event.data.result.kind === "tool-result" &&
              typeof event.data.result.output === "object" &&
              event.data.result.output !== null &&
              "taskId" in event.data.result.output,
          ),
        ).toBe(true);

        // The question arrives after the turn that called the tool ended.
        let request: InputRequestedStreamEvent["data"]["requests"][number] | undefined;
        for (let turn = 0; turn < 3 && request === undefined; turn += 1) {
          const woken = await stream.nextTurn();
          expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
          request = (
            filterEventsByType(woken, "input.requested")[0] as InputRequestedStreamEvent | undefined
          )?.data.requests[0];
        }
        expect(request).toMatchObject({ kind: "question", prompt: "Apply plan:api?" });

        // The stable session inbox already took the task's wake, so it is
        // known to exist; answer through it directly.
        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          kind: "send",
          payload: { inputResponses: [{ optionId: "approve", requestId: request!.requestId }] },
        });

        const notifications: string[] = [];
        for (
          let turn = 0;
          turn < 3 && !notifications.some((text) => text.includes("is completed"));
          turn += 1
        ) {
          const woken = await stream.nextTurn();
          expect(filterEventsByType(woken, "turn.failed")).toHaveLength(0);
          notifications.push(eventsText(filterEventsByType(woken, "message.received")));
        }
        const text = notifications.join("\n");
        expect(text).toContain("is completed");
        expect(text).toContain('\\"approved\\":true');
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 90_000);
});

/** Flags one manifest tool as `execution: "background"` under `experimental.tasks`. */
function enableBackgroundTool(runtime: TestRuntime, toolName: string): void {
  const artifacts = runtime.session.compiledArtifacts;
  if (artifacts === null) throw new Error("expected installed compiled artifacts");
  runtime.session.compiledArtifacts = {
    ...artifacts,
    manifest: {
      ...artifacts.manifest,
      config: artifacts.manifest.config,
      tools: artifacts.manifest.tools.map((tool) =>
        tool.name === toolName ? { ...tool, execution: "background" as const } : tool,
      ),
    },
  };
}

function eventsText(events: readonly { readonly data?: unknown }[]): string {
  return events.map((event) => JSON.stringify(event.data ?? null)).join("\n");
}
