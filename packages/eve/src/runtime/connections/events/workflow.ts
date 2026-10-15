import { createHook, sleep, type HookOptions } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import { parseJsonObject } from "#shared/json.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import { connectionEventHookToken } from "#runtime/connections/events/path.js";
import type { ConnectionEventWatch, EventBinding } from "#runtime/connections/events/state.js";
import { dispatchConnectionEventStep } from "#runtime/connections/events/dispatch-step.js";
import {
  openConnectionEventStep,
  publishConnectionEventOutcomeStep,
} from "#runtime/connections/events/lifecycle-step.js";

export type ConnectionEventWatchMessage = { readonly kind: "retire" };

/**
 * How long an ended watch stays findable by its id, so get and a repeated
 * stop still reach Connect while it finishes upstream cleanup.
 */
export const ENDED_WATCH_RETENTION = "7d";

/**
 * Holds one watch: its hook carries the binding every delivery runs under,
 * and the run waits until the watch is stopped, terminated or expires.
 * Deliveries run in their own {@link connectionEventDeliveryWorkflow}, so
 * this run's log stays a few entries long however many events arrive.
 */
export async function connectionEventWorkflow(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use workflow";
  const token = connectionEventHookToken(input.binding.id);
  const hook = createHook<ConnectionEventWatchMessage>({
    token,
    metadata: watchMetadata({ binding: input.binding, ended: false }),
  });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
    // A retried subscribing tool started a second run: its caller reads the first one.
    await publishConnectionEventOutcomeStep({ ownerRunId: error.conflictingRunId });
    return;
  }
  try {
    const opened = await openConnectionEventStep({
      serializedContext: input.serializedContext,
      binding: input.binding,
    });
    if ("error" in opened) return;
    const { expiresAt } = opened.subscription;
    // Connect ends the subscription at expiresAt and sends nothing more.
    await (expiresAt === null ? hook : Promise.race([hook, sleep(new Date(expiresAt))]));
    await disposeHook(hook);
    // The ended watch stays addressable without a registry: this finished run
    // keeps its token, and its subscription stays readable from its stream.
    await claimHookOwnership(
      createHook<ConnectionEventWatchMessage>({
        token,
        metadata: watchMetadata({ binding: input.binding, ended: true }),
        experimental_minRetention: ENDED_WATCH_RETENTION,
      }),
    );
  } finally {
    await disposeHook(hook);
  }
}

/** Normalizes the saved binding before it crosses Workflow's serializable metadata boundary. */
function watchMetadata(watch: ConnectionEventWatch): HookOptions["metadata"] {
  return parseJsonObject(watch) as HookOptions["metadata"];
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
