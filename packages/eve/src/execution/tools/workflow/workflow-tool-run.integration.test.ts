import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateStepArguments } from "#compiled/@workflow/core/serialization.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
  readFirstTurnReply,
} from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { SLEEP_INPUT_SCHEMA } from "#tools/provided/sleep.js";
import { executeSleepTool } from "#tools/provided/sleep-workflow.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  askThenRaceWorkflow,
  answerWithResponderWorkflow,
  confirmDeployWorkflow,
  deployServiceWorkflow,
  failingDeployWorkflow,
  reportingDeployWorkflow,
  stepReferenceWorkflow,
  workflowContextMisuseWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
import type { InputRequestedStreamEvent, MessageStreamEvent } from "#protocol/message.js";
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
        // The call is still running, so the question parks the open turn.
        const [parked] = filterEventsByType(asked, "turn.waiting");
        expect(asked.at(-1)).toBe(parked);
        expect(filterEventsByType(asked, "turn.completed")).toHaveLength(0);

        const commandToken = sessionCommandHookToken(run.runId);
        await resumeSessionInbox(commandToken, {
          kind: "send",
          payload: { inputResponses: [{ optionId: "approve", requestId: request.requestId }] },
        });

        const answered = await stream.nextTurn();
        expect(filterEventsByType(answered, "input.resolved")).toMatchObject([
          { data: { resolutions: [{ outcome: "answered", requestId: request.requestId }] } },
        ]);
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
        // The answer resumes the same turn, which completes once.
        const turnIds = new Set(
          answered.flatMap((event) =>
            "data" in event && "turnId" in event.data ? [event.data.turnId] : [],
          ),
        );
        expect([...turnIds]).toEqual([parked!.data.turnId]);
        expect(filterEventsByType(answered, "turn.started")).toHaveLength(0);
        expect(filterEventsByType(answered, "turn.completed")).toHaveLength(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
    expect(output.unexpected(workflowSdkNotice.unpinnedDelivery)).toEqual([]);
  }, 60_000);

  it("exposes the principal that answered ctx.ask", async () => {
    const alice = {
      attributes: {},
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    };
    const bob = {
      ...alice,
      attributes: { private: "channel-only" },
      principalId: "bob",
    };
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-ask-responder",
      execute: answerWithResponderWorkflow,
      toolName: "confirm_deploy",
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run confirm_deploy with service "api"' },
          serializedContext: {
            ...buildWorkflowToolSerializedContext({
              continuationToken: "http:workflow-tool-ask-responder",
              requestInput: true,
            }),
            "eve.auth": alice,
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const requested = await stream.nextTurn();
        const request = (
          filterEventsByType(requested, "input.requested")[0] as InputRequestedStreamEvent
        ).data.requests[0]!;
        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          auth: bob,
          kind: "send",
          payload: { inputResponses: [{ optionId: "approve", requestId: request.requestId }] },
        });

        const answered = await stream.nextTurn();
        const result = filterEventsByType(answered, "action.result").find(
          (event) =>
            event.data.result.kind === "tool-result" &&
            event.data.result.toolName === "confirm_deploy",
        );
        expect(JSON.parse(String(result?.data.result.output))).toEqual({
          answer: {
            optionId: "approve",
            responder: {
              authenticator: "test",
              principalId: "bob",
              principalType: "user",
            },
            status: "answered",
          },
          runStartPrincipal: "alice",
        });
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);

  it("lets a deadline win a race against an unanswered ask and withdraws the ask", async () => {
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
        const requested = filterEventsByType(asked, "input.requested");
        expect(requested).toHaveLength(1);
        const requestId = requested[0]!.data.requests[0]!.requestId;

        const outputs: string[] = [];
        const resumedEvents: MessageStreamEvent[] = [];
        // A replayed parked boundary may arrive before the deadline result.
        for (let attempt = 0; attempt < 5 && outputs.length === 0; attempt += 1) {
          const resumed = await stream.nextTurn();
          resumedEvents.push(...resumed);
          expect(filterEventsByType(resumed, "turn.failed")).toHaveLength(0);
          expect(filterEventsByType(resumed, "session.failed")).toHaveLength(0);
          outputs.push(
            ...filterEventsByType(resumed, "action.result").map((event) =>
              JSON.stringify(event.data.result.output),
            ),
          );
        }
        expect(outputs.some((output) => output.includes('"decided":"timed out"'))).toBe(true);
        // The run returned without the answer, so channels must stop offering its question.
        expect(
          filterEventsByType(resumedEvents, "input.resolved").map(
            (event) => event.data.resolutions,
          ),
        ).toEqual([[{ kind: "question", outcome: "cancelled", requestId }]]);
        expect(containsEventSequence(resumedEvents, ["input.resolved", "action.result"])).toBe(
          true,
        );
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

  it("keeps the conversation out of the step input of a session step that only publishes", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "workflow-tool-step-input",
      execute: reportingDeployWorkflow,
      toolName: "deploy_service",
    });
    // Not the first message, which also becomes the session title in the context.
    const earlyNote = "Alice notes that the api rollout window opens at noon.";

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Alice starts planning the api rollout." },
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:workflow-tool-step-input",
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      const send = async (message: string) => {
        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          kind: "send",
          payload: { message },
        });
        return await stream.nextTurn();
      };
      try {
        await stream.nextTurn();
        await send(earlyNote);
        const settled = await send('Run deploy_service with service "api"');
        expect(filterEventsByType(settled, "action.partial")).toHaveLength(1);

        const inputs = await readStepInputs(run.runId);
        const reportInputs = inputs.get("emitWorkflowToolRunReportStep") ?? [];
        expect(reportInputs).toHaveLength(1);
        expect(reportInputs[0]).not.toContain(earlyNote);
        expect(inputs.get("turnStep")?.at(-1)).toContain(earlyNote);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 30_000);
});

/** Each step's persisted `step_created` input, serialized, grouped by step name in creation order. */
async function readStepInputs(runId: string): Promise<Map<string, string[]>> {
  const world = await getWorld();
  const events = await world.events.list({
    pagination: { limit: 1000 },
    resolveData: "all",
    runId,
  });
  const inputs = new Map<string, string[]>();
  for (const event of events.data) {
    if (event.eventType !== "step_created") continue;
    const name = event.eventData.stepName.split("//").at(-1) ?? "";
    const input = await hydrateStepArguments(event.eventData.input, runId, undefined);
    inputs.set(name, [...(inputs.get(name) ?? []), JSON.stringify(input)]);
  }
  return inputs;
}
