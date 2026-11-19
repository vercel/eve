import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { channelSubscriptionWorkflowReference } from "#execution/workflow-references.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { bindingContext } from "#runtime/subscriptions/owner.js";
import {
  readPublishedOutcome,
  readPublishedOutcomeNow,
} from "#runtime/subscriptions/published-outcome.js";
import {
  CHANNEL_SUBSCRIPTION_OUTCOME_NAMESPACE,
  channelKeyHookToken,
  channelSubscriptionHookToken,
  type ChannelKeyMessage,
  type ChannelSubscriptionBinding,
  type ChannelSubscriptionOutcome,
  type ChannelSubscriptionStatus,
  type ChannelSubscriptionWatchMessage,
} from "#runtime/subscriptions/channel/state.js";
import type { ChannelEvent } from "#shared/channel-subscriptions.js";

export async function startChannelSubscriptionOwner(
  binding: ChannelSubscriptionBinding,
  bundle: CompiledBundle,
  signal?: AbortSignal,
): Promise<ChannelSubscriptionStatus | undefined> {
  const run = await startWorkflowOnCurrentDeployment(channelSubscriptionWorkflowReference, [
    { binding, serializedContext: await bindingContext(binding, bundle) },
  ]);
  let outcome = await readPublishedOutcome<ChannelSubscriptionOutcome>(
    run.runId,
    CHANNEL_SUBSCRIPTION_OUTCOME_NAMESPACE,
    signal,
  );
  if (outcome !== undefined && "ownerRunId" in outcome)
    outcome = await readPublishedOutcome<ChannelSubscriptionOutcome>(
      outcome.ownerRunId,
      CHANNEL_SUBSCRIPTION_OUTCOME_NAMESPACE,
      signal,
    );
  if (outcome !== undefined && "ownerRunId" in outcome)
    throw new Error("Channel subscription ownership did not resolve.");
  return outcome?.status;
}

export async function findChannelSubscriptionOwner(bindingId: string): Promise<
  | {
      readonly binding: ChannelSubscriptionBinding;
      readonly status: ChannelSubscriptionStatus | undefined;
    }
  | undefined
> {
  let hook;
  try {
    hook = await getHookByToken(channelSubscriptionHookToken(bindingId));
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
  const outcome = await readPublishedOutcomeNow<ChannelSubscriptionOutcome>(
    hook.runId,
    CHANNEL_SUBSCRIPTION_OUTCOME_NAMESPACE,
  );
  return {
    binding: (await hook.metadata) as ChannelSubscriptionBinding,
    status: outcome !== undefined && "status" in outcome ? outcome.status : undefined,
  };
}

export function retireChannelSubscriptionOwner(bindingId: string): Promise<boolean> {
  return resume(channelSubscriptionHookToken(bindingId), {
    kind: "retire",
  } satisfies ChannelSubscriptionWatchMessage);
}

export function emitChannelSubscriptionEvent(
  channelName: string,
  key: string,
  event: ChannelEvent,
): Promise<boolean> {
  return resume(channelKeyHookToken(channelName, key), {
    kind: "emit",
    event,
  } satisfies ChannelKeyMessage);
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
