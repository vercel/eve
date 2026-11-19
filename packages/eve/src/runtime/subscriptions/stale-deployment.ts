import { createHash } from "node:crypto";
import { SUBSCRIPTION_CHANNEL_KIND } from "#channel/delivery-metadata.js";
import { createAttachSessionFn } from "#channel/session.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type { AlsContext } from "#context/container.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { requireCompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { retireSubscriptionOwner } from "#runtime/subscriptions/owner.js";
import type { SubscriptionBinding, SubscriptionEvent } from "#runtime/subscriptions/state.js";

/**
 * Whether the deployment that accepted `event` differs from the one holding `binding`. A
 * subscription runs the callbacks of the deployment that opened it, so after a redeploy it would
 * keep applying the old deployment's event rules. Neither id is set outside a hosted deployment.
 */
export function isHeldByOlderDeployment(
  binding: SubscriptionBinding,
  event: SubscriptionEvent,
): boolean {
  return (
    binding.deploymentId !== undefined &&
    event.acceptedDeploymentId !== undefined &&
    binding.deploymentId !== event.acceptedDeploymentId
  );
}

/** Ends the subscription without delivering, and tells its session to subscribe again. */
export async function retireOlderDeploymentSubscription(input: {
  readonly ctx: AlsContext;
  readonly binding: SubscriptionBinding;
}): Promise<void> {
  const { ctx, binding } = input;
  await retireSubscriptionOwner(binding.id);
  const source = binding.source;
  const what =
    source.kind === "channel"
      ? `to the event "${source.event}" on channel "${source.name}"`
      : `to events from connection "${source.name}"`;
  const bundle = requireCompiledBundle(ctx);
  const attach = createAttachSessionFn(
    createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
    { turnPolicy: "queue", channelKind: SUBSCRIPTION_CHANNEL_KIND, channelName: source.name },
  );
  try {
    await attach(binding.sessionId).send(
      `Your subscription ${what} ended because the agent was redeployed, and an event arrived that its older deployment can no longer judge. Subscribe again if you still need it.`,
      {
        auth: binding.auth,
        turnPolicy: "queue",
        idempotencyKey: `eve:subscription-retired:${createHash("sha256").update(binding.id).digest("hex")}`,
      },
    );
  } catch (error) {
    if (!SessionNotActiveError.is(error) || error.retryable) throw error;
  }
}
