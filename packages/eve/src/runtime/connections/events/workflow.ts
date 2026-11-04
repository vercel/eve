import { createHook, sleep, type HookOptions } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import { parseJsonObject } from "#shared/json.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import { connectionEventHookToken } from "#runtime/connections/events/path.js";
import type { EventBinding } from "#runtime/connections/events/state.js";
import { dispatchConnectionEventStep } from "#runtime/connections/events/dispatch-step.js";
import {
  openConnectionEventStep,
  publishConnectionEventOutcomeStep,
  startConnectionEventDeliveryStep,
  unsubscribeConnectionEventStep,
} from "#runtime/connections/events/lifecycle-step.js";

export type ConnectionEventWatchMessage =
  | { readonly kind: "retire" }
  /** A delivery that reached the receiver before this run published its subscription. */
  | { readonly kind: "delivery"; readonly payload: ConnectionEventPayload };

/** Unsubscribe repeats until Connect's cleanup completes, through outages and refusals. */
const FIRST_UNSUBSCRIBE_RETRY_MS = 5_000;
const LAST_UNSUBSCRIBE_RETRY_MS = 3_600_000;

/**
 * Holds one watch: its hook carries the binding every delivery runs under,
 * and the run waits until the watch is stopped, terminated or expires.
 * Deliveries run in their own {@link connectionEventDeliveryWorkflow}, so
 * this run's log only grows by the deliveries that arrive before its
 * subscribe response does. The hook ends with the run: an ended watch is
 * not found.
 */
export async function connectionEventWorkflow(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use workflow";
  const { binding, serializedContext } = input;
  const hook = createHook<ConnectionEventWatchMessage>({
    token: connectionEventHookToken(binding.id),
    metadata: parseJsonObject(binding) as HookOptions["metadata"],
  });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
    // The same watch was asked for again while it runs: its caller reads the first run.
    await publishConnectionEventOutcomeStep({ ownerRunId: error.conflictingRunId });
    return;
  }
  const opened = await openConnectionEventStep({ serializedContext, binding });
  if ("error" in opened) {
    // Nothing was subscribed: asking for the same watch again starts over.
    await disposeHook(hook);
    return;
  }
  const { id: subscriptionId, expiresAt } = opened.subscription;
  // Connect ends the subscription at expiresAt and sends nothing more.
  const expiry = expiresAt === null ? undefined : sleep(new Date(expiresAt));
  while (true) {
    const message = await (expiry === undefined ? hook : Promise.race([hook, expiry]));
    if (message === undefined) return;
    if (message.kind === "retire") break;
    // Connect verifies the destination, not the subscription: only this run's own runs.
    if (message.payload.delivery.subscriptionId === subscriptionId)
      await startConnectionEventDeliveryStep({
        binding,
        serializedContext,
        payload: message.payload,
      });
  }
  let retryMs = FIRST_UNSUBSCRIBE_RETRY_MS;
  while (
    (await unsubscribeConnectionEventStep({ serializedContext, binding, subscriptionId })) ===
    "pending"
  ) {
    await sleep(retryMs);
    retryMs = Math.min(retryMs * 2, LAST_UNSUBSCRIBE_RETRY_MS);
  }
}

/** Runs one delivery's callback in its own short run. */
export async function connectionEventDeliveryWorkflow(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly payload: ConnectionEventPayload;
}): Promise<void> {
  "use workflow";
  await dispatchConnectionEventStep(input);
}
