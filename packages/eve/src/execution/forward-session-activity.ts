import type { SubagentActivityHookPayload } from "#channel/types.js";
import { agentActivityEvent } from "#channel/task-card.js";
import type { ContextContainer } from "#context/container.js";
import { LegacyRemoteAgentCallerKey, SessionCallbackKey } from "#context/keys.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import { createLogger } from "#internal/logging.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { isSubagentAdapterState, SUBAGENT_ADAPTER_KIND } from "#subagents/adapter-state.js";

const log = createLogger("execution.session-activity");

/** Activity is best effort, so a slow caller never holds the child's step for long. */
const ACTIVITY_CALLBACK_TIMEOUT_MS = 5_000;

/**
 * A delegated session reports each tool call it starts or settles to the
 * caller awaiting its turn, beside its own channel: a local child resumes the
 * caller's hook, and a remote child posts to its session callback. Never
 * throws, since activity is never worth failing the child's step over.
 */
export async function forwardSessionActivity(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
): Promise<void> {
  const caller = activityCaller(ctx);
  if (caller === undefined) return;
  const activity = agentActivityEvent(event);
  if (activity === undefined) return;
  const payload: SubagentActivityHookPayload = {
    callId: caller.callId,
    event: activity,
    kind: "subagent-activity",
  };
  try {
    if (caller.kind === "hook") {
      await resumeHook(caller.token, payload);
      return;
    }
    const response = await postSessionCallbackRequest({
      body: payload,
      logFailures: false,
      timeoutMs: ACTIVITY_CALLBACK_TIMEOUT_MS,
      url: caller.url,
    });
    if (!response.ok) throw new Error(`Activity callback failed with HTTP ${response.status}.`);
  } catch (error) {
    log.warn("failed to report subagent activity to its caller", {
      callId: caller.callId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

type ActivityCaller =
  | { readonly callId: string; readonly kind: "hook"; readonly token: string }
  | { readonly callId: string; readonly kind: "callback"; readonly url: string };

function activityCaller(ctx: ContextContainer): ActivityCaller | undefined {
  const callback = ctx.get(SessionCallbackKey);
  if (callback !== undefined) {
    // A legacy caller's protocol has no activity payload.
    if (ctx.get(LegacyRemoteAgentCallerKey) !== undefined) return undefined;
    return { callId: callback.callId, kind: "callback", url: callback.url };
  }
  const adapter = ctx.get(ChannelKey);
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND || !isSubagentAdapterState(adapter.state)) {
    return undefined;
  }
  return {
    callId: adapter.state.callId,
    kind: "hook",
    token: adapter.state.parentContinuationToken,
  };
}
