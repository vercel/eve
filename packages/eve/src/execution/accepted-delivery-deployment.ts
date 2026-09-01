import type { HookPayload } from "#channel/types.js";
import type { TurnStepInput } from "#execution/durable-session-migrations/turn-workflow.js";
import type { DurableStepResult } from "#execution/next-driver-action.js";

/** Returns one trusted accepting deployment only when every delivery agrees. */
export function readAcceptedDeploymentId(input: HookPayload): string | undefined {
  if (input.kind !== "deliver" || input.deliveryMetadata?.length === 0) return undefined;
  const acceptedDeploymentId = input.deliveryMetadata?.[0]?.acceptedDeploymentId;
  if (acceptedDeploymentId === undefined || acceptedDeploymentId.length === 0) return undefined;
  return input.deliveryMetadata?.every(
    (metadata) => metadata.acceptedDeploymentId === acceptedDeploymentId,
  )
    ? acceptedDeploymentId
    : undefined;
}

/** Defers a speculative inline step before mutation when it reached another deployment. */
export function deferMismatchedInlineTurnStep(input: TurnStepInput): DurableStepResult | undefined {
  if (
    input.acceptedDeploymentId === undefined ||
    process.env.VERCEL_DEPLOYMENT_ID?.trim() === input.acceptedDeploymentId
  ) {
    return undefined;
  }
  return {
    action: "continue",
    requiresChildDispatch: true,
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  };
}
