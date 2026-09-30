import { expect, it } from "vitest";

import {
  hydrateStepArguments,
  hydrateStepReturnValue,
} from "#compiled/@workflow/core/serialization.js";
import { workflowEntry } from "#execution/session/entry.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import {
  buildWorkflowToolSerializedContext,
  createWorkflowToolRuntime,
} from "#internal/testing/workflow-tool-run-harness.js";
import { deployServiceWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { readFirstTurnReply } from "#internal/testing/events.js";

const CANCEL_STEP =
  "step//./src/execution/tools/subagent/task-cancel//cancelAgentInvocationOwnerStep";
const RELEASE_STEP =
  "step//./src/execution/tools/subagent/invoke-step//releaseAgentInvocationOwnerStep";

it("does not persist session state in cleanup steps for a workflow tool with no agent handles", async () => {
  const runtime = await createWorkflowToolRuntime({
    agentName: "workflow-tool-without-agent-handles",
    execute: deployServiceWorkflow,
    toolName: "deploy_service",
  });

  await runtime.run(async () => {
    const run = await start(workflowEntry, [
      {
        kind: "initial",
        ownerDeploymentId: "dpl_inline",
        input: { message: 'Run deploy_service with service "api"' },
        serializedContext: buildWorkflowToolSerializedContext({
          continuationToken: "schedule:workflow-tool-without-agent-handles",
        }),
      },
    ]);
    expect(String(await readFirstTurnReply(run))).toContain('"plan":"plan:api"');

    const world = await getWorld();
    const { data: events } = await world.events.list({
      pagination: { limit: 1_000 },
      resolveData: "all",
      runId: run.runId,
    });
    const cancelCreated = findStepEvent(events, "step_created", CANCEL_STEP);
    const releaseCreated = findStepEvent(events, "step_created", RELEASE_STEP);
    const releaseCompleted = findStepEvent(events, "step_completed", RELEASE_STEP);

    const hasSessionState = [
      await stepArgumentsIncludeSessionState(cancelCreated, run.runId),
      await stepArgumentsIncludeSessionState(releaseCreated, run.runId),
      await stepResultIncludesSessionState(releaseCompleted, run.runId),
    ];
    expect(hasSessionState).toEqual([false, false, false]);
  });
});

function findStepEvent(
  events: readonly unknown[],
  eventType: string,
  stepName: string,
): Record<string, unknown> | undefined {
  const event = events.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.eventType === eventType &&
      isRecord(candidate.eventData) &&
      candidate.eventData.stepName === stepName,
  );
  return isRecord(event) && isRecord(event.eventData) ? event.eventData : undefined;
}

async function stepArgumentsIncludeSessionState(
  eventData: Record<string, unknown> | undefined,
  runId: string,
): Promise<boolean> {
  if (!(eventData?.input instanceof Uint8Array)) return false;
  const input = await hydrateStepArguments(eventData.input, runId, undefined);
  if (!isRecord(input) || !Array.isArray(input.args)) return false;
  return isRecord(input.args[0]) && Object.hasOwn(input.args[0], "sessionState");
}

async function stepResultIncludesSessionState(
  eventData: Record<string, unknown> | undefined,
  runId: string,
): Promise<boolean> {
  if (!(eventData?.result instanceof Uint8Array)) return false;
  const result = await hydrateStepReturnValue(eventData.result, runId, undefined);
  return isRecord(result) && Object.hasOwn(result, "sessionState");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
