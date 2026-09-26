import { afterEach, describe, expect, it, vi } from "vitest";
import { start } from "#internal/workflow/runtime.js";
import {
  captureTurnEvents,
  filterEventsByType,
  readFirstTurnReply,
} from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { SLEEP_INPUT_SCHEMA, executeSleepTool } from "#execution/tools/sleep.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  askThenRaceWorkflow,
  confirmDeployWorkflow,
  deployServiceWorkflow,
  failingDeployWorkflow,
  reportingDeployWorkflow,
  stepReferenceWorkflow,
  workflowContextMisuseWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import type { InputRequestedStreamEvent } from "#protocol/message.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";
import { captureConsoleOutput, workflowSdkNotice } from "#internal/testing/log-records.js";

describe("workflow tools", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("invokes restored step references with bound arguments and receivers", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-step-reference",
      execute: stepReferenceWorkflow,
      toolName: "deploy_service",
    });
    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "schedule:step-reference",
          }),
        },
      ]);
      return String(await readFirstTurnReply(run));
    });
    expect(output).toContain('"argument":"plan:api"');
    expect(output).toContain('"receiver":"api"');
  });
  it("runs the framework sleep tool through the workflow tool path", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-sleep",
      execute: executeSleepTool,
      inputSchema: SLEEP_INPUT_SCHEMA,
      toolName: "sleep",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Run sleep" },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "schedule:workflow-tool-sleep",
          }),
        },
      ]);
      return String(await readFirstTurnReply(run));
    });

    expect(output).toContain('"waitedSeconds":1');
  });

  it("parks the turn on a workflow tool and resumes with its return value", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-wait",
      execute: deployServiceWorkflow,
      toolName: "deploy_service",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "schedule:workflow-tool-wait",
          }),
        },
      ]);
      return String(await readFirstTurnReply(run));
    });

    expect(output).toContain('"plan":"plan:api"');
    expect(output).toContain('"callId":"call_deploy_service');
  });

  it("fails workflow-context misuse in a step with actionable guidance", async () => {
    const consoleOutput = captureConsoleOutput();
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-step-context-misuse",
      execute: workflowContextMisuseWorkflow,
      toolName: "deploy_service",
    });

    const output = await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "schedule:workflow-step-context-misuse",
          }),
        },
      ]);
      return String(await readFirstTurnReply(run));
    });

    expect(output).toContain('ctx.agents is unavailable inside a "use step" function.');
    expect(output).toContain(
      "Read ctx.agents in the workflow body and pass the required serializable metadata into the step.",
    );
    expect(output).toContain("Attempt 1.");
    expect(consoleOutput.lines).toContainEqual(
      expect.stringContaining(workflowSdkNotice.fatalStep),
    );
    expect(consoleOutput.unexpected(workflowSdkNotice.fatalStep)).toEqual([]);
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
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "schedule:workflow-tool-fail",
          }),
        },
      ]);
      return String(await readFirstTurnReply(run));
    });

    expect(output).toContain("deploy of api exploded");
  });

  it("routes workflow reports, human input, and outcome through the session owner", async () => {
    const output = captureConsoleOutput();
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_inline");
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-hitl",
      execute: confirmDeployWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            acceptedDeploymentId: "dpl_inline",
            continuationToken: "http:workflow-tool-hitl",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);

      try {
        const asked = await stream.nextTurn();
        expect(
          filterEventsByType(asked, "action.partial").map((event) => event.data.result.output),
        ).toEqual(["awaiting approval"]);
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
        await resumeSessionInbox(commandToken, {
          kind: "send",
          payload: { inputResponses: [{ optionId: "approve", requestId: request.requestId }] },
        });

        const answered = await stream.nextTurn();
        const progress = answered.findIndex(
          (event) =>
            event.type === "action.partial" && event.data.result.output === "approval received",
        );
        const resultIndex = answered.findIndex(
          (event) =>
            event.type === "action.result" &&
            event.data.result.kind === "tool-result" &&
            event.data.result.toolName === "confirm_deploy",
        );
        expect(progress, JSON.stringify(answered)).toBeGreaterThanOrEqual(0);
        expect(resultIndex).toBeGreaterThan(progress);
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
    expect(output.unexpected(workflowSdkNotice.unpinnedDelivery)).toEqual([]);
  }, 60_000);

  it("lets a deadline win a race against an unanswered ask", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-ask-deadline",
      execute: askThenRaceWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-ask-deadline",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        // Asking parks the turn; the sleep then wins and the same turn resumes.
        const asked = await stream.nextTurn();
        expect(filterEventsByType(asked, "input.requested")).toHaveLength(1);

        const outputs: string[] = [];
        // A replayed parked boundary may arrive before the deadline result.
        for (let attempt = 0; attempt < 5 && outputs.length === 0; attempt += 1) {
          const resumed = await stream.nextTurn();
          expect(filterEventsByType(resumed, "turn.failed")).toHaveLength(0);
          expect(filterEventsByType(resumed, "session.failed")).toHaveLength(0);
          outputs.push(
            ...filterEventsByType(resumed, "action.result").map((event) =>
              JSON.stringify(event.data.result.output),
            ),
          );
        }
        expect(outputs.some((output) => output.includes('"decided":"timed out"'))).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);

  it("streams a waiting tool's yields as action.partial and settles with its return", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-progress",
      execute: reportingDeployWorkflow,
      toolName: "deploy_service",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-progress",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const settled = await stream.nextTurn();
        const partials = filterEventsByType(settled, "action.partial").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(partials).toContainEqual(JSON.stringify("planned api"));
        const results = filterEventsByType(settled, "action.result").map((event) =>
          JSON.stringify(event.data.result.output),
        );
        expect(results).toContainEqual(JSON.stringify({ plan: "plan:api" }));
        expect(filterEventsByType(settled, "turn.failed")).toHaveLength(0);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);
});
