import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createTestRuntime, type TestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import {
  askThenRaceWorkflow,
  confirmDeployWorkflow,
  deployServiceWorkflow,
  failingDeployWorkflow,
  holdUntilAbortedWorkflow,
  reportingDeployWorkflow,
  stepThenRaceWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getRun, getWorld, start } from "#internal/workflow/runtime.js";
import { toolRunWorkflowReference } from "#execution/workflow-runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { InputRequestedStreamEvent } from "#protocol/message.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { readWorkflowToolId } from "#shared/workflow-tool.js";
import { toInputSchema } from "#tools/schema.js";

const DEPLOY_INPUT_SCHEMA = toInputSchema({
  additionalProperties: false,
  properties: { service: { type: "string" } },
  required: ["service"],
  type: "object",
});

function buildSerializedContext(input: {
  readonly continuationToken: string;
  readonly mode: "conversation" | "task";
  readonly requestInput?: boolean;
}): Record<string, unknown> {
  return {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.capabilities": { requestInput: input.requestInput ?? false },
    "eve.channel": { kind: "http", state: {} },
    "eve.continuationToken": input.continuationToken,
    "eve.mode": input.mode,
  };
}

/**
 * Registers one fixture workflow as an authored tool. The fixture module
 * passed through the test tier's client transform, so `execute` is the stub
 * the real pipeline produces: a function carrying its `workflowId`.
 */
async function createWorkflowToolRuntime(input: {
  readonly agentName: string;
  readonly execute: (...args: never[]) => unknown;
  readonly toolName: string;
}): Promise<TestRuntime> {
  expect(readWorkflowToolId(input.execute)).toEqual(expect.any(String));
  const tool: ResolvedToolDefinition = {
    description: `Deploys a service (${input.toolName}).`,
    execute: input.execute as ResolvedToolDefinition["execute"],
    inputSchema: DEPLOY_INPUT_SCHEMA,
    logicalPath: `tools/${input.toolName}.ts`,
    name: input.toolName,
    owner: { kind: "application" },
    sourceId: `tools/${input.toolName}.ts`,
    sourceKind: "module",
  };
  const runtime = await createTestRuntime({ agent: { name: input.agentName }, tools: [tool] });
  const manifestTool = runtime.manifest.tools.find((entry) => entry.name === input.toolName);
  if (manifestTool === undefined) {
    throw new Error(`Expected ${input.toolName} to be present in the test manifest.`);
  }
  runtime.moduleMap.nodes[ROOT_COMPILED_AGENT_NODE_ID]!.modules[manifestTool.sourceId] = {
    default: { execute: input.execute },
  };
  return runtime;
}

/** Ids of every tool run in the shared world, so a test can spot the one it started. */
async function listToolRunIds(): Promise<Set<string>> {
  const world = await getWorld();
  const page = await world.runs.list({ pagination: { limit: 100 } });
  return new Set(
    page.data
      .filter(
        (entry: { readonly workflowName?: string }) =>
          entry.workflowName === toolRunWorkflowReference.workflowId,
      )
      .map((entry: { readonly runId: string }) => entry.runId),
  );
}

/** Polls until exactly one tool run exists that was not in `before`. */
async function waitForNewToolRun(before: ReadonlySet<string>, timeout = 15_000): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const started = [...(await listToolRunIds())].filter((runId) => !before.has(runId));
    if (started.length === 1) return started[0]!;
    if (started.length > 1) throw new Error(`Expected one new tool run, found ${started.length}.`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a tool run to start.");
}

/** Polls one run until it reaches a terminal status, returning that status. */
async function waitForRunTerminal(runId: string, timeout = 15_000): Promise<string> {
  const terminal = new Set(["completed", "failed", "cancelled"]);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const status = await getRun(runId).status;
    if (terminal.has(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach a terminal status.`);
}

function eventsText(events: readonly { readonly data?: unknown }[]): string {
  return events.map((event) => JSON.stringify(event.data ?? null)).join("\n");
}

describe("workflow tools", () => {
  it("parks the turn on a workflow tool and resumes with its return value", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-wait",
      execute: deployServiceWorkflow,
      toolName: "deploy_service",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "schedule:workflow-tool-wait",
            mode: "task",
          }),
        },
      ]);
      const result = await run.returnValue;
      return String(result.output);
    });

    expect(output).toContain('"plan":"plan:api"');
    expect(output).toContain('"callId":"call_deploy_service');
  });

  it("settles the call with an error when the workflow body throws", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-fail",
      execute: failingDeployWorkflow,
      toolName: "deploy_service",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "schedule:workflow-tool-fail",
            mode: "task",
          }),
        },
      ]);
      const result = await run.returnValue;
      return String(result.output);
    });

    expect(output).toContain("deploy of api exploded");
  });

  it("routes a human answer to the waiting workflow body", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-hitl",
      execute: confirmDeployWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-hitl",
            mode: "conversation",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const asked = await stream.nextTurn();
        const requested = filterEventsByType(asked, "input.requested");
        expect(requested).toHaveLength(1);
        const request = (requested[0] as InputRequestedStreamEvent).data.requests[0]!;
        expect(request).toMatchObject({
          action: { input: { service: "api" }, kind: "tool-call", toolName: "confirm_deploy" },
          display: "confirmation",
          kind: "question",
          prompt: "Apply plan:api?",
        });
        expect(request.options?.map((option) => option.id)).toEqual(["approve", "cancel"]);

        const commandToken = sessionCommandHookToken(run.runId);
        await waitForHook(run, { token: commandToken });
        await resumeSessionInbox(commandToken, {
          kind: "send",
          payload: { inputResponses: [{ optionId: "approve", requestId: request.requestId }] },
        });

        const answered = await stream.nextTurn();
        const results = filterEventsByType(answered, "action.result");
        expect(results.map((event) => JSON.stringify(event.data.result.output))).toContainEqual(
          JSON.stringify({ approved: true, service: "api" }),
        );
        expect(filterEventsByType(answered, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("times out a hook raced against a sleep when it is not resumed", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-deadline",
      execute: stepThenRaceWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Run deploy_service" },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-deadline",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const settled = await stream.nextTurn();
        const outputs = filterEventsByType(settled, "action.result").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(outputs.some((output) => output.includes('"decided":"timed out"'))).toBe(true);
        expect(filterEventsByType(settled, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);

  it("lets a deadline win a race against an unanswered ask", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-ask-deadline",
      execute: askThenRaceWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-ask-deadline",
            mode: "conversation",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        // Asking parks the turn; the sleep then wins and the same turn resumes.
        const asked = await stream.nextTurn();
        expect(filterEventsByType(asked, "input.requested")).toHaveLength(1);

        const resumed = await stream.nextTurn();
        const outputs = filterEventsByType(resumed, "action.result").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(outputs.some((output) => output.includes('"decided":"timed out"'))).toBe(true);
        expect(filterEventsByType(resumed, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);

  it("cancels the run when the waiting turn is cancelled and lets the body clean up", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-cancel",
      execute: holdUntilAbortedWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const before = await listToolRunIds();
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildSerializedContext({
            continuationToken: "http:workflow-tool-cancel",
            mode: "conversation",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const toolRunId = await waitForNewToolRun(before);
        const commandToken = sessionCommandHookToken(run.runId);
        await waitForHook(run, { token: commandToken });
        await resumeSessionInbox(commandToken, { kind: "cancel", turnId: "turn_0" });

        // The body is holding in a step that received ctx.abortSignal, so the
        // run ends well inside its grace period once the step rejects and
        // `finally` runs; a run that ignored the signal would still be running.
        expect(await waitForRunTerminal(toolRunId)).toBe("completed");

        await resumeSessionInbox(commandToken, {
          kind: "send",
          payload: { message: "Thanks, no deploy today." },
        });
        const next = await stream.nextTurn();
        expect(filterEventsByType(next, "turn.started")).toHaveLength(1);
        expect(filterEventsByType(next, "turn.failed")).toHaveLength(0);
        expect(next.at(-1)?.type).toBe("session.waiting");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("runs a background workflow tool as its task's executor", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-background",
      execute: reportingDeployWorkflow,
      toolName: "report_deploy",
    });

    await runtime.run(async () => {
      enableBackgroundTool(runtime, "report_deploy");

      const run = await start(workflowEntry, [
        {
          input: { message: 'Run report_deploy with service "api"' },
          serializedContext: buildSerializedContext({
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
        expect(text).toContain("update: planned api");
        expect(text).toContain("is completed");
        expect(text).toContain("plan:api");
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
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildSerializedContext({
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
      config: { ...artifacts.manifest.config, experimental: { tasks: true } },
      tools: artifacts.manifest.tools.map((tool) =>
        tool.name === toolName ? { ...tool, execution: "background" as const } : tool,
      ),
    },
  };
}
