import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import {
  CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
  type ConnectionEventSubscribeOutcome,
  type ConnectionEventSubscribeResult,
  type EventBinding,
} from "#runtime/connections/events/state.js";
import type { ConnectionEventWatchMessage } from "#runtime/connections/events/workflow.js";
import {
  connectionEventDeliveryWorkflowReference,
  connectionEventWorkflowReference,
  startWorkflowOnCurrentDeployment,
} from "#execution/workflow-runtime.js";
import { getHookByToken, getRun, resumeHook } from "#internal/workflow/runtime.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { connectionEventHookToken } from "#runtime/connections/events/path.js";
import type { ManagedEventSubscription } from "#shared/connection-events.js";

/** Bounds the wait for a run's first step, which itself subscribes with a 30 s timeout. */
const SUBSCRIBE_OUTCOME_TIMEOUT_MS = 90_000;

/** The context a watch's runs execute in: its creator's auth and origin session. */
function bindingContext(binding: EventBinding, bundle: CompiledBundle): Record<string, unknown> {
  const ctx = new ContextContainer({ localDevRequest: undefined });
  ctx.set(BundleKey, bundle);
  ctx.set(AuthKey, binding.auth);
  if (binding.traceSeed !== undefined) ctx.set(SessionTraceSeedKey, binding.traceSeed);
  // This is origin metadata, not a conversation owner or a state snapshot.
  ctx.set(SessionIdKey, binding.sessionId);
  return serializeContext(ctx);
}

/**
 * Starts the watch's run, which subscribes once its hook is registered. A
 * watch already running under the binding's id answers instead. Returns
 * undefined when the subscription is still being created after the caller
 * stops waiting: asking for the same watch again finds it.
 */
export async function startConnectionEventOwner(
  binding: EventBinding,
  bundle: CompiledBundle,
  signal?: AbortSignal,
): Promise<ManagedEventSubscription | undefined> {
  const run = await startWorkflowOnCurrentDeployment(connectionEventWorkflowReference, [
    { binding, serializedContext: bindingContext(binding, bundle) },
  ]);
  const outcome = await readSubscribeOutcome(run.runId, signal);
  return outcome && subscriptionFromOutcome(outcome);
}

/**
 * Routes one verified delivery to its watch. Returns false when the watch
 * has ended or never created this subscription, so the receiver tells
 * Connect to stop. A delivery that beats the subscribe response waits in the
 * watch's own hook, and the watch's run starts it once it knows its
 * subscription.
 */
export async function startConnectionEventDelivery(
  payload: ConnectionEventPayload,
  bundle: CompiledBundle,
): Promise<boolean> {
  const watch = await findConnectionEventOwner(payload.bindingId);
  if (watch === undefined) return false;
  if (watch.subscription === undefined)
    return resumeWatch(payload.bindingId, { kind: "delivery", payload });
  if (watch.subscription.id !== payload.delivery.subscriptionId) return false;
  const binding = watch.owner;
  await startConnectionEventDeliveryRun({
    binding,
    serializedContext: bindingContext(binding, bundle),
    payload,
  });
  return true;
}

/** Runs one delivery's callback in its own short run. */
export async function startConnectionEventDeliveryRun(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly payload: ConnectionEventPayload;
}): Promise<void> {
  await startWorkflowOnCurrentDeployment(connectionEventDeliveryWorkflowReference, [input]);
}

/** Connect's refusal reaches the caller with its status, so a 401 is classified as a sign-in request. */
export function subscriptionFromOutcome(
  outcome: ConnectionEventSubscribeResult,
): ManagedEventSubscription {
  if ("error" in outcome) throw Object.assign(new Error(outcome.error), { status: outcome.status });
  return outcome.subscription;
}

/**
 * A running watch: who owns it and what it subscribed to. The subscription
 * is undefined while it is still being created. An ended watch's hook ended
 * with its run, so it is not found.
 */
export async function findConnectionEventOwner(
  bindingId: string,
): Promise<
  { owner: EventBinding; subscription: ManagedEventSubscription | undefined } | undefined
> {
  let hook;
  try {
    hook = await getHookByToken(connectionEventHookToken(bindingId));
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
  const outcome = await readPublishedOutcomeNow(hook.runId);
  // The hook's run is the owner, so it never points at another run.
  if (outcome !== undefined && !("subscription" in outcome)) return undefined;
  return { owner: (await hook.metadata) as EventBinding, subscription: outcome?.subscription };
}

/** Asks the watch's run to unsubscribe and end; the run repeats unsubscribe until Connect finishes. */
export async function retireConnectionEventOwner(bindingId: string): Promise<boolean> {
  return resumeWatch(bindingId, { kind: "retire" });
}

async function resumeWatch(
  bindingId: string,
  message: ConnectionEventWatchMessage,
): Promise<boolean> {
  try {
    await resumeHook(connectionEventHookToken(bindingId), message);
    return true;
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
}

/** What the run that owns this binding subscribed to, following a duplicate run to that owner. */
async function readSubscribeOutcome(
  runId: string,
  signal?: AbortSignal,
): Promise<ConnectionEventSubscribeResult | undefined> {
  const outcome = await readPublishedOutcome(runId, signal);
  if (outcome === undefined || !("ownerRunId" in outcome)) return outcome;
  const owned = await readPublishedOutcome(outcome.ownerRunId, signal);
  if (owned !== undefined && "ownerRunId" in owned)
    throw new Error("Event handler ownership did not resolve.");
  return owned;
}

/** The run's published outcome if it has one yet, without waiting for it. */
async function readPublishedOutcomeNow(
  runId: string,
): Promise<ConnectionEventSubscribeOutcome | undefined> {
  const readable = getRun(runId).getReadable({
    namespace: CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
  });
  const tail = await readable.getTailIndex();
  await readable.cancel().catch(() => {});
  return tail < 0 ? undefined : readPublishedOutcome(runId);
}

/** The run's published outcome, or undefined if the caller stops waiting before it is published. */
async function readPublishedOutcome(
  runId: string,
  signal?: AbortSignal,
): Promise<ConnectionEventSubscribeOutcome | undefined> {
  const reader = getRun(runId)
    .getReadable<ConnectionEventSubscribeOutcome>({
      namespace: CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
    })
    .getReader();
  const deadline = AbortSignal.any([
    AbortSignal.timeout(SUBSCRIBE_OUTCOME_TIMEOUT_MS),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const abandoned = new Promise<{ value: undefined; abandoned: true }>((resolve) => {
    const abort = () => resolve({ value: undefined, abandoned: true });
    if (deadline.aborted) abort();
    else deadline.addEventListener("abort", abort, { once: true });
  });
  try {
    const read = await Promise.race([reader.read(), abandoned]);
    if ("abandoned" in read) return undefined;
    if (read.value === undefined) throw new Error("Event handler ended before subscribing.");
    return read.value;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
