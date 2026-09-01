import {
  createTurnWorkflowInput,
  type TurnWorkflowDispatchInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { buildTurnAttributes, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import {
  startWorkflowPreferAcceptedDeployment,
  turnWorkflowReference,
} from "#execution/workflow-runtime.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";

/** Starts a per-turn child workflow for the current driver session. */
export async function dispatchTurnStep(
  input: TurnWorkflowDispatchInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const run = await startWorkflowPreferAcceptedDeployment(
    turnWorkflowReference,
    [createTurnWorkflowInput(input)],
    readAcceptedDeploymentId(input.delivery),
    {
      allowReservedAttributes: true,
      attributes: normalizeEveAttributes(
        buildTurnAttributes({
          parentSessionId: input.sessionState.sessionId,
          requestId: input.delivery.kind === "deliver" ? input.delivery.requestId : undefined,
          rootSessionId: readRootSessionId(input.serializedContext) ?? input.sessionState.sessionId,
          serializedContext: input.serializedContext,
        }),
      ),
    },
  );

  return { runId: run.runId };
}

function readAcceptedDeploymentId(
  input: TurnWorkflowDispatchInput["delivery"],
): string | undefined {
  if (input.kind !== "deliver" || input.deliveryMetadata?.length === 0) return undefined;
  const acceptedDeploymentId = input.deliveryMetadata?.[0]?.acceptedDeploymentId;
  if (acceptedDeploymentId === undefined || acceptedDeploymentId.length === 0) return undefined;
  return input.deliveryMetadata?.every(
    (metadata) => metadata.acceptedDeploymentId === acceptedDeploymentId,
  )
    ? acceptedDeploymentId
    : undefined;
}
