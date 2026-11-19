import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { startWorkflowOnCurrentDeployment } from "#execution/workflow-runtime.js";
import { channelEventWorkflowReference } from "#execution/workflow-references.js";
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { bindingContext } from "#runtime/connections/events/owner.js";
import {
  CHANNEL_EVENT_OUTCOME_NAMESPACE,
  channelEventHookToken,
  type ChannelEventBinding,
  type ChannelEventOutcome,
  type ChannelEventStatus,
  type ChannelEventWatchMessage,
} from "#runtime/channels/events/state.js";
import {
  readPublishedOutcome,
  readPublishedOutcomeNow,
} from "#runtime/events/published-outcome.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import type { ChannelEventDelivery } from "#shared/channel-subscriptions.js";

export async function startChannelEventOwner(
  binding: ChannelEventBinding,
  bundle: CompiledBundle,
  signal?: AbortSignal,
): Promise<ChannelEventStatus | undefined> {
  const run = await startWorkflowOnCurrentDeployment(channelEventWorkflowReference, [
    { binding, serializedContext: await bindingContext(binding, bundle) },
  ]);
  let outcome = await readPublishedOutcome<ChannelEventOutcome>(
    run.runId,
    CHANNEL_EVENT_OUTCOME_NAMESPACE,
    signal,
  );
  if (outcome !== undefined && "ownerRunId" in outcome)
    outcome = await readPublishedOutcome<ChannelEventOutcome>(
      outcome.ownerRunId,
      CHANNEL_EVENT_OUTCOME_NAMESPACE,
      signal,
    );
  if (outcome !== undefined && "ownerRunId" in outcome)
    throw new Error("Event subscription ownership did not resolve.");
  return outcome?.status;
}

export async function findChannelEventOwner(
  bindingId: string,
): Promise<{ binding: ChannelEventBinding; status: ChannelEventStatus | undefined } | undefined> {
  let hook;
  try {
    hook = await getHookByToken(channelEventHookToken(bindingId));
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
  const outcome = await readPublishedOutcomeNow<ChannelEventOutcome>(
    hook.runId,
    CHANNEL_EVENT_OUTCOME_NAMESPACE,
  );
  return {
    binding: (await hook.metadata) as ChannelEventBinding,
    status: outcome !== undefined && "status" in outcome ? outcome.status : undefined,
  };
}

export function retireChannelEventOwner(bindingId: string): Promise<boolean> {
  return resumeWatch(bindingId, { kind: "retire" });
}

export function publishChannelEvent(
  bindingId: string,
  delivery: ChannelEventDelivery,
): Promise<boolean> {
  return resumeWatch(bindingId, { kind: "delivery", delivery });
}

async function resumeWatch(bindingId: string, message: ChannelEventWatchMessage): Promise<boolean> {
  try {
    await resumeHook(channelEventHookToken(bindingId), message);
    return true;
  } catch (error) {
    if (HookNotFoundError.is(error)) return false;
    throw error;
  }
}
