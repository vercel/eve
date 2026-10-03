import { afterEach, describe, expect, it, vi } from "vitest";
import { hydrateStepArguments } from "#compiled/@workflow/core/serialization.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import {
  captureTurnEvents,
  filterEventsByType,
  readFirstTurnReply,
} from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { SLEEP_INPUT_SCHEMA } from "#tools/provided/sleep.js";
import { executeSleepTool } from "#tools/provided/sleep-workflow.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import {
  deployServiceWorkflow,
  failingDeployWorkflow,
  reportingDeployWorkflow,
  stepReferenceWorkflow,
  workflowContextMisuseWorkflow,
} from "#internal/testing/workflow-tool-fixtures.js";
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
