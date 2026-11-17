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
  | { readonly kind: "delivery"; readonly payload: ConnectionEventPayload };

const FIRST_UNSUBSCRIBE_RETRY_MS = 5_000;
const LAST_UNSUBSCRIBE_RETRY_MS = 3_600_000;

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
    await publishConnectionEventOutcomeStep({ ownerRunId: error.conflictingRunId });
    return;
  }
  const opened = await openConnectionEventStep({ serializedContext, binding });
  if ("error" in opened) {
    await disposeHook(hook);
    return;
  }
  const { id: subscriptionId, expiresAt } = opened.subscription;
  const expiry = expiresAt === null ? undefined : sleep(new Date(expiresAt));
  while (true) {
    const message = await (expiry === undefined ? hook : Promise.race([hook, expiry]));
    if (message === undefined) return;
    if (message.kind === "retire") break;
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

export async function connectionEventDeliveryWorkflow(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly payload: ConnectionEventPayload;
}): Promise<void> {
  "use workflow";
  await dispatchConnectionEventStep(input);
}
