import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { subscriptionWorkflowReference } from "#execution/workflow-references.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { compiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { type CompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import {
  readPublishedOutcome,
  readPublishedOutcomeNow,
} from "#runtime/subscriptions/published-outcome.js";
import {
  SUBSCRIPTION_OUTCOME_NAMESPACE,
  subscriptionHookToken,
  subscriptionKeyHookToken,
  type OpenedSubscription,
  type SubscriptionBinding,
  type SubscriptionEvent,
  type SubscriptionKeyMessage,
  type SubscriptionOutcome,
  type SubscriptionOwnerMessage,
  type SubscriptionSourceRef,
} from "#runtime/subscriptions/state.js";

export async function bindingContext(
  binding: Pick<SubscriptionBinding, "auth" | "sessionId" | "traceSeed">,
  bundle: CompiledBundle,
): Promise<Record<string, unknown>> {
  const ctx = new ContextContainer({ localDevRequest: undefined });
  ctx.set(SessionAgentKey, await compiledSessionAgent(bundle));
  ctx.set(AuthKey, binding.auth);
  if (binding.traceSeed !== undefined) ctx.set(SessionTraceSeedKey, binding.traceSeed);
  ctx.set(SessionIdKey, binding.sessionId);
  return serializeContext(ctx);
}

export async function startSubscriptionOwner(
  binding: SubscriptionBinding,
  bundle: CompiledBundle,
  signal?: AbortSignal,
): Promise<OpenedSubscription | undefined> {
  const run = await startWorkflowOnCurrentDeployment(subscriptionWorkflowReference, [
    {
      binding,
      serializedContext: await bindingContext(binding, bundle),
    },
  ]);
  let outcome = await readPublishedOutcome<SubscriptionOutcome>(
    run.runId,
    SUBSCRIPTION_OUTCOME_NAMESPACE,
    signal,
  );
  if (outcome !== undefined && "ownerRunId" in outcome)
    outcome = await readPublishedOutcome<SubscriptionOutcome>(
      outcome.ownerRunId,
      SUBSCRIPTION_OUTCOME_NAMESPACE,
      signal,
    );
  if (outcome !== undefined && "ownerRunId" in outcome)
    throw new Error("Subscription ownership did not resolve.");
  if (outcome === undefined) return undefined;
  if ("error" in outcome) throw Object.assign(new Error(outcome.error), { status: outcome.status });
  return outcome.opened;
}

export async function findSubscriptionOwner(
  bindingId: string,
): Promise<{ binding: SubscriptionBinding; opened: OpenedSubscription | undefined } | undefined> {
  let hook;
  try {
    hook = await getHookByToken(subscriptionHookToken(bindingId));
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
  const outcome = await readPublishedOutcomeNow<SubscriptionOutcome>(
    hook.runId,
    SUBSCRIPTION_OUTCOME_NAMESPACE,
  );
  if (outcome !== undefined && !("opened" in outcome)) return undefined;
  return { binding: (await hook.metadata) as SubscriptionBinding, opened: outcome?.opened };
}

export function retireSubscriptionOwner(bindingId: string): Promise<boolean> {
  return resume(subscriptionHookToken(bindingId), {
    kind: "retire",
  } satisfies SubscriptionOwnerMessage);
}

export function emitSubscriptionEvent(
  source: SubscriptionSourceRef,
  key: string,
  event: SubscriptionEvent,
): Promise<boolean> {
  return resume(subscriptionKeyHookToken(source, key), {
    kind: "emit",
    event,
  } satisfies SubscriptionKeyMessage);
}

async function resume(token: string, message: unknown): Promise<boolean> {
  try {
    await resumeHook(token, message);
    return true;
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
}
