import { createHook, sleep, type HookOptions } from "#compiled/@workflow/core/index.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import { parseJsonObject } from "#shared/json.js";
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
  retireOwnersStep,
  startSubscriptionDeliveryStep,
  type SubscriptionDeliveryInput,
} from "#runtime/subscriptions/steps.js";
import {
  SESSION_KEY_SOURCE,
  sourceRef,
  subscriptionHookToken,
  subscriptionKeyHookToken,
  type SubscriptionBinding,
  type SubscriptionKeyMessage,
  type OpenedSubscription,
  type SubscriptionEvent,
  type SubscriptionKeySource,
  type SubscriptionOwnerMessage,
} from "#runtime/subscriptions/state.js";

const FIRST_CLOSE_RETRY_MS = 5_000;
const LAST_CLOSE_RETRY_MS = 3_600_000;
const REMEMBERED_EVENTS = 256;

export async function subscriptionWorkflow(input: {
  readonly binding: SubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use workflow";
  const { binding, serializedContext } = input;
  const hook = createHook<SubscriptionOwnerMessage>({
    token: subscriptionHookToken(binding.id),
    metadata: parseJsonObject(binding) as HookOptions["metadata"],
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
  const sharesKey = binding.source.kind === "channel";
  const sessionKey = { binding, source: SESSION_KEY_SOURCE, key: binding.sessionId };
  const channelKey = { binding, source: sourceRef(binding.source), key: opened.key };
  const joins = sharesKey ? [sessionKey, channelKey] : [sessionKey];
  const joined: KeyJoin[] = [];
  try {
    for (const join of joins) {
      await joinKeyStep(join);
      joined.push(join);
    }
  } catch (error) {
    await publishOpenOutcomeStep({ error: toErrorMessage(error) });
    await closeSubscription({ binding, serializedContext, opened }, joined);
    await disposeHook(hook);
    throw error;
  }
  await publishOpenOutcomeStep(outcome);
  const expiry = opened.expiresAt === null ? undefined : sleep(new Date(opened.expiresAt));
  const seen: string[] = [];
  while (true) {
    const message = await (expiry === undefined ? hook : Promise.race([hook, expiry]));
    if (message === undefined || message.kind === "retire") break;
    if (!fromThisSubscription(binding, opened, message.event) || seen.includes(message.event.id))
      continue;
    seen.push(message.event.id);
    if (seen.length > REMEMBERED_EVENTS) seen.shift();
    await startSubscriptionDeliveryStep({ binding, event: message.event });
  }
  await closeSubscription({ binding, serializedContext, opened }, joined);
}

type KeyJoin = Parameters<typeof joinKeyStep>[0];

async function closeSubscription(
  input: {
    readonly binding: SubscriptionBinding;
    readonly serializedContext: Record<string, unknown>;
    readonly opened: OpenedSubscription;
  },
  joined: readonly KeyJoin[],
): Promise<void> {
  for (const join of joined.toReversed()) await leaveKeyStep(join);
  let retryMs = FIRST_CLOSE_RETRY_MS;
  while ((await closeSubscriptionStep(input)) === "pending") {
    await sleep(retryMs);
    retryMs = Math.min(retryMs * 2, LAST_CLOSE_RETRY_MS);
  }
}

function fromThisSubscription(
  binding: SubscriptionBinding,
  opened: OpenedSubscription,
  event: SubscriptionEvent,
): boolean {
  if (binding.source.kind !== "connection") return true;
  return isObject(event.data) && event.data.subscriptionId === opened.key;
}

export async function subscriptionKeyWorkflow(input: {
  readonly source: SubscriptionKeySource;
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
    });
    return;
  }
  const members = new Set([input.first]);
  await acknowledgeJoinStep(input.ackId);
  while (members.size > 0) {
    const message = await hook;
    if (message.kind === "join") {
      members.add(message.bindingId);
      await acknowledgeJoinStep(message.ackId);
    } else if (message.kind === "leave") members.delete(message.bindingId);
    else if (message.kind === "retire") {
      await retireOwnersStep({ bindingIds: [...members] });
      members.clear();
    } else
      for (const gone of await fanOutEventStep({ bindingIds: [...members], event: message.event }))
        members.delete(gone);
  }
  await disposeHook(hook);
}

export async function subscriptionDeliveryWorkflow(
  input: SubscriptionDeliveryInput,
): Promise<void> {
  "use workflow";
  await dispatchSubscriptionStep(input);
}
