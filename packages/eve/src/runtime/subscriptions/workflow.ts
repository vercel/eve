import { createHook, sleep, type HookOptions } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  acknowledgeJoinStep,
  closeSubscriptionStep,
  dispatchSubscriptionStep,
  fanOutEventStep,
  forwardJoinStep,
  joinKeyStep,
  leaveKeyStep,
  openSubscriptionStep,
  publishOpenOutcomeStep,
  publishSubscriptionOwnerStep,
  startSubscriptionDeliveryStep,
  type SubscriptionDeliveryInput,
} from "#runtime/subscriptions/steps.js";
import {
  subscriptionHookToken,
  subscriptionKeyHookToken,
  type SubscriptionBinding,
  type SubscriptionKeyMessage,
  type SubscriptionOwnerMessage,
  type SubscriptionSourceRef,
} from "#runtime/subscriptions/state.js";

const FIRST_CLOSE_RETRY_MS = 5_000;
const LAST_CLOSE_RETRY_MS = 3_600_000;
const REMEMBERED_EVENTS = 256;

/**
 * Holds one session's subscription: opens it with its source, joins the key the source names,
 * forwards the events its key run hands it, and closes it when it expires or is retired.
 */
export async function subscriptionWorkflow(input: {
  readonly binding: SubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use workflow";
  const { binding, serializedContext } = input;
  const hook = createHook<SubscriptionOwnerMessage>({
    token: subscriptionHookToken(binding.id),
    // The binding is workflow input, so it is already serialized JSON.
    metadata: binding as unknown as HookOptions["metadata"],
  });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
    await publishSubscriptionOwnerStep(error.conflictingRunId);
    return;
  }
  const outcome = await openSubscriptionStep({ serializedContext, binding });
  if ("error" in outcome) {
    await publishOpenOutcomeStep(outcome);
    await disposeHook(hook);
    return;
  }
  const { opened } = outcome;
  await joinKeyStep({ binding, key: opened.key });
  await publishOpenOutcomeStep(outcome);
  const expiry = opened.expiresAt === null ? undefined : sleep(new Date(opened.expiresAt));
  while (true) {
    const message = await (expiry === undefined ? hook : Promise.race([hook, expiry]));
    if (message === undefined || message.kind === "retire") break;
    await startSubscriptionDeliveryStep({ binding, serializedContext, event: message.event });
  }
  await leaveKeyStep({ binding, key: opened.key });
  let retryMs = FIRST_CLOSE_RETRY_MS;
  while ((await closeSubscriptionStep({ binding, serializedContext, opened })) === "pending") {
    await sleep(retryMs);
    retryMs = Math.min(retryMs * 2, LAST_CLOSE_RETRY_MS);
  }
}

/**
 * Fans each event emitted for one key of one source out to the subscriptions holding it, once per
 * event id. Ends when no subscription holds the key. A join is acknowledged once this run holds the
 * subscription, so a join that arrives as the run ends is never mistaken for one that was kept.
 */
export async function subscriptionKeyWorkflow(input: {
  readonly source: SubscriptionSourceRef;
  readonly key: string;
  readonly first: string;
  readonly ackId: string;
}): Promise<void> {
  "use workflow";
  const { source, key } = input;
  const hook = createHook<SubscriptionKeyMessage>({ token: subscriptionKeyHookToken(source, key) });
  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (!isHookConflictError(error) || typeof error.conflictingRunId !== "string") throw error;
    await forwardJoinStep({
      source,
      key,
      bindingId: input.first,
      ackId: input.ackId,
      to: error.conflictingRunId,
    });
    return;
  }
  const members = new Set([input.first]);
  await acknowledgeJoinStep(input.ackId);
  const seen: string[] = [];
  while (members.size > 0) {
    const message = await hook;
    if (message.kind === "join") {
      members.add(message.bindingId);
      await acknowledgeJoinStep(message.ackId);
    } else if (message.kind === "leave") members.delete(message.bindingId);
    else if (!seen.includes(message.event.id)) {
      seen.push(message.event.id);
      if (seen.length > REMEMBERED_EVENTS) seen.shift();
      for (const gone of await fanOutEventStep({ bindingIds: [...members], event: message.event }))
        members.delete(gone);
    }
  }
  await disposeHook(hook);
}

export async function subscriptionDeliveryWorkflow(
  input: SubscriptionDeliveryInput,
): Promise<void> {
  "use workflow";
  await dispatchSubscriptionStep(input);
}
