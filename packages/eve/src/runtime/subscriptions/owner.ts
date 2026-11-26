import { ContextContainer } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { subscriptionWorkflowReference } from "#execution/workflow-references.js";
import {
  resolveCurrentWorkflowDeploymentId,
  startWorkflowOnCurrentDeployment,
} from "#execution/workflow-runtime.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { serializeDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { compiledSessionAgent } from "#runtime/sessions/compiled-session-agent.js";
import { type CompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import { findOwnerHook, resumeKey, resumeOwner } from "#runtime/subscriptions/hooks.js";
import {
  readPublishedOutcome,
  readPublishedOutcomeNow,
} from "#runtime/subscriptions/published-outcome.js";
import {
  SUBSCRIPTION_OUTCOME_NAMESPACE,
  sourceRef,
  type OpenedSubscription,
  type SubscriptionBinding,
  type SubscriptionEvent,
  type SubscriptionOccurrence,
  type SubscriptionOutcome,
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
  const hook = await findOwnerHook(bindingId);
  if (hook === undefined) return undefined;
  const outcome = await readPublishedOutcomeNow<SubscriptionOutcome>(
    hook.runId,
    SUBSCRIPTION_OUTCOME_NAMESPACE,
  );
  if (outcome !== undefined && !("opened" in outcome)) return undefined;
  return { binding: (await hook.metadata) as SubscriptionBinding, opened: outcome?.opened };
}

export function retireSubscriptionOwner(bindingId: string): Promise<boolean> {
  return resumeOwner(bindingId, { kind: "retire" });
}

async function eventFrom(
  occurrence: SubscriptionOccurrence,
  source: RuntimeCompiledArtifactsSource,
): Promise<SubscriptionEvent> {
  return {
    ...occurrence,
    origin: {
      deploymentId: await resolveCurrentWorkflowDeploymentId(),
      compiledArtifactsSource: serializeDurableCompiledArtifactsSource(source),
    },
  };
}

export async function emitSubscriptionEvent(
  channelName: string,
  key: string,
  occurrence: SubscriptionOccurrence,
  source: RuntimeCompiledArtifactsSource,
): Promise<boolean> {
  const runId = await resumeKey({ kind: "channel", name: channelName }, key, {
    kind: "emit",
    event: await eventFrom(occurrence, source),
  });
  return runId !== undefined;
}

export async function deliverSubscriptionEvent(
  bindingId: string,
  from: SubscriptionSourceRef,
  occurrence: SubscriptionOccurrence,
  source: RuntimeCompiledArtifactsSource,
): Promise<boolean> {
  const hook = await findOwnerHook(bindingId);
  if (hook === undefined) return false;
  const owner = sourceRef(((await hook.metadata) as SubscriptionBinding).source);
  if (owner.kind !== from.kind || owner.name !== from.name) return false;
  return resumeOwner(bindingId, { kind: "delivery", event: await eventFrom(occurrence, source) });
}
