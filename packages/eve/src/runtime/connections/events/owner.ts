import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import {
  CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
  type ConnectionEventSubscribeOutcome,
  type ConnectionEventSubscribeResult,
  type ConnectionEventWatch,
  type EventBinding,
  type EventOwner,
} from "#runtime/connections/events/state.js";
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

/** Starts the watch's run, which subscribes once its hook is registered. */
export async function startConnectionEventOwner(
  binding: EventBinding,
  bundle: CompiledBundle,
  signal?: AbortSignal,
): Promise<ManagedEventSubscription> {
  const run = await startWorkflowOnCurrentDeployment(connectionEventWorkflowReference, [
    { binding, serializedContext: bindingContext(binding, bundle) },
  ]);
  return subscriptionFromOutcome(await readSubscribeOutcome(run.runId, signal));
}

/**
 * Starts a run for one delivery under the binding its watch's hook carries.
 * Returns false when the watch has ended, so the receiver can tell Connect.
 */
export async function startConnectionEventDelivery(
  payload: ConnectionEventPayload,
  bundle: CompiledBundle,
): Promise<boolean> {
  const watch = await findWatch(payload.bindingId);
  if (watch === undefined || watch.metadata.ended) return false;
  const { binding } = watch.metadata;
  await startWorkflowOnCurrentDeployment(connectionEventDeliveryWorkflowReference, [
    { binding, serializedContext: bindingContext(binding, bundle), payload },
  ]);
  return true;
}

async function findWatch(
  bindingId: string,
): Promise<{ runId: string; metadata: ConnectionEventWatch } | undefined> {
  try {
    const hook = await getHookByToken(connectionEventHookToken(bindingId));
    return { runId: hook.runId, metadata: (await hook.metadata) as ConnectionEventWatch };
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
}

/** Connect's refusal reaches the caller with its status, so a 401 is classified as a sign-in request. */
export function subscriptionFromOutcome(
  outcome: ConnectionEventSubscribeResult,
): ManagedEventSubscription {
  if ("error" in outcome) throw Object.assign(new Error(outcome.error), { status: outcome.status });
  return outcome.subscription;
}

/** A watch, live or recently ended: who owns it and what it subscribed to. */
export async function findConnectionEventOwner(
  bindingId: string,
): Promise<{ owner: EventOwner; subscription: ManagedEventSubscription } | undefined> {
  const watch = await findWatch(bindingId);
  if (watch === undefined) return undefined;
  const outcome = await readSubscribeOutcome(watch.runId);
  return "error" in outcome
    ? undefined
    : { owner: watch.metadata.binding, subscription: outcome.subscription };
}

/** Ends the watch's run; an ended watch's retained hook has no run left to resume. */
export async function retireConnectionEventOwner(bindingId: string): Promise<void> {
  const watch = await findWatch(bindingId);
  if (watch === undefined || watch.metadata.ended) return;
  try {
    await resumeHook(connectionEventHookToken(bindingId), { kind: "retire" });
  } catch (error) {
    if (!HookNotFoundError.is(error)) throw error;
  }
}

/** What the run that owns this binding subscribed to, following a duplicate run to that owner. */
async function readSubscribeOutcome(
  runId: string,
  signal?: AbortSignal,
): Promise<ConnectionEventSubscribeResult> {
  const outcome = await readPublishedOutcome(runId, signal);
  if (!("ownerRunId" in outcome)) return outcome;
  const owned = await readPublishedOutcome(outcome.ownerRunId, signal);
  if ("ownerRunId" in owned) throw new Error("Event handler ownership did not resolve.");
  return owned;
}

async function readPublishedOutcome(
  runId: string,
  signal?: AbortSignal,
): Promise<ConnectionEventSubscribeOutcome> {
  const reader = getRun(runId)
    .getReadable<ConnectionEventSubscribeOutcome>({
      namespace: CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
    })
    .getReader();
  const deadline = AbortSignal.any([
    AbortSignal.timeout(SUBSCRIBE_OUTCOME_TIMEOUT_MS),
    ...(signal === undefined ? [] : [signal]),
  ]);
  const abandoned = new Promise<never>((_, reject) => {
    const abort = () => reject(deadline.reason);
    if (deadline.aborted) abort();
    else deadline.addEventListener("abort", abort, { once: true });
  });
  try {
    const { value } = await Promise.race([reader.read(), abandoned]);
    if (value === undefined) throw new Error("Event handler ended before subscribing.");
    return value;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
