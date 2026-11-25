import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { compiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { type CompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ConnectionEventPayload } from "#runtime/subscriptions/delivery.js";
import {
  CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
  type ConnectionEventSubscribeOutcome,
  type ConnectionEventSubscribeResult,
  type EventBinding,
} from "#runtime/subscriptions/state.js";
import type { ConnectionEventWatchMessage } from "#runtime/subscriptions/workflow.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import {
  connectionEventDeliveryWorkflowReference,
  connectionEventWorkflowReference,
} from "#execution/workflow-references.js";
import { getHookByToken, getRun, resumeHook } from "#internal/workflow/runtime.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { connectionEventHookToken } from "#runtime/subscriptions/path.js";
import type { ManagedEventSubscription } from "#shared/connection-events.js";

const SUBSCRIBE_OUTCOME_TIMEOUT_MS = 90_000;

async function bindingContext(
  binding: EventBinding,
  bundle: CompiledBundle,
): Promise<Record<string, unknown>> {
  const ctx = new ContextContainer({ localDevRequest: undefined });
  ctx.set(SessionAgentKey, await compiledSessionAgent(bundle));
  ctx.set(AuthKey, binding.auth);
  if (binding.traceSeed !== undefined) ctx.set(SessionTraceSeedKey, binding.traceSeed);
  ctx.set(SessionIdKey, binding.sessionId);
  return serializeContext(ctx);
}

export async function startConnectionEventOwner(
  binding: EventBinding,
  bundle: CompiledBundle,
  signal?: AbortSignal,
): Promise<ManagedEventSubscription | undefined> {
  const run = await startWorkflowOnCurrentDeployment(connectionEventWorkflowReference, [
    { binding, serializedContext: await bindingContext(binding, bundle) },
  ]);
  const outcome = await readSubscribeOutcome(run.runId, signal);
  return outcome && subscriptionFromOutcome(outcome);
}

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
    serializedContext: await bindingContext(binding, bundle),
    payload,
  });
  return true;
}

export async function startConnectionEventDeliveryRun(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly payload: ConnectionEventPayload;
}): Promise<void> {
  await startWorkflowOnCurrentDeployment(connectionEventDeliveryWorkflowReference, [input]);
}

export function subscriptionFromOutcome(
  outcome: ConnectionEventSubscribeResult,
): ManagedEventSubscription {
  if ("error" in outcome) throw Object.assign(new Error(outcome.error), { status: outcome.status });
  return outcome.subscription;
}

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
  if (outcome !== undefined && !("subscription" in outcome)) return undefined;
  return { owner: (await hook.metadata) as EventBinding, subscription: outcome?.subscription };
}

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
