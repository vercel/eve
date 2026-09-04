import { getWorld } from "#internal/workflow/runtime.js";
import { createLogger } from "#internal/logging.js";
import { createUlid } from "#shared/ulid.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { buildTurnAttributes, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import type { TurnWorkflowInput } from "#execution/durable-session-migrations/turn-workflow.js";
import {
  startWorkflowOnAcceptedDeployment,
  turnWorkflowReference,
} from "#execution/workflow-runtime.js";

interface RetainedTurn {
  readonly deploymentId: string;
  readonly runId: string;
}

/** Persists the target and run identity before starting any retained execution. */
export async function prepareRetainedTurnStep(
  sessionId: string,
): Promise<RetainedTurn | undefined> {
  "use step";

  const currentDeploymentId = process.env.VERCEL_DEPLOYMENT_ID?.trim();
  if (!currentDeploymentId) return undefined;
  const world = await getWorld();
  const parent = await world.runs.get(sessionId, { resolveData: "none" });
  if (parent.deploymentId === currentDeploymentId) return undefined;

  const suffix = world.createRunId?.({ deploymentId: parent.deploymentId }) ?? createUlid();
  return { deploymentId: parent.deploymentId, runId: `wrun_${suffix}` };
}

/** The retained child speaks directly to the original parent's unchanged control hooks. */
export async function startRetainedTurnStep(
  target: RetainedTurn,
  rawInput: unknown,
  input: TurnWorkflowInput,
): Promise<void> {
  "use step";

  const world = await getWorld();
  // Workflow start uses the World's ID factory and accepts an existing run ID.
  // Keep the prepared ID on retries, including after the child disposed its hooks.
  const startWorld = { ...world, createRunId: () => target.runId.slice("wrun_".length) };
  const sessionId = input.stepInput.sessionState.sessionId;
  await startWorkflowOnAcceptedDeployment(turnWorkflowReference, [rawInput], target.deploymentId, {
    world: startWorld,
    allowReservedAttributes: true,
    attributes: normalizeEveAttributes(
      buildTurnAttributes({
        parentSessionId: sessionId,
        rootSessionId: readRootSessionId(input.stepInput.serializedContext) ?? sessionId,
        serializedContext: input.stepInput.serializedContext,
      }),
    ),
  });
  createLogger("execution.retained-turn").info(
    "using retained session code for an incompatible turn state contract",
    {
      sessionId,
      deploymentId: target.deploymentId,
      runId: target.runId,
    },
  );
}
