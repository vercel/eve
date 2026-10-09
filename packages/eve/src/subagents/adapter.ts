import type { ChannelAdapter } from "#channel/adapter.js";
import { registerFactHandlers, type FactHandlerContext } from "#channel/fact-handlers.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey, SessionInboxKey } from "#context/keys.js";
import { openedBatch, relayedInteractionEvent } from "#harness/interaction-relay.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { SUBAGENT_ADAPTER_KIND, isSubagentAdapterState } from "#subagents/adapter-state.js";
import { createErrorId, createLogger } from "#internal/logging.js";

const log = createLogger("execution.subagent-adapter");

/**
 * Framework adapter that bridges a child subagent session to its parent.
 *
 * It relays each batch of requests the child opens, so the parent channel can render them and
 * route answers back down, and the changes only the child decides: its sign-ins, how it settled
 * an approval or ended a request early, and an answer it refused.
 */
export const SUBAGENT_ADAPTER: ChannelAdapter = { kind: SUBAGENT_ADAPTER_KIND };

registerFactHandlers(SUBAGENT_ADAPTER_KIND, {
  async "interaction.opened"(data, ctx) {
    const state = ctx.state;
    if (!isSubagentAdapterState(state)) return;
    if (data.request.kind === "sign-in") {
      await forwardRelayed({ data, type: "interaction.opened" }, ctx);
      return;
    }
    const event = openedBatch(ctx.view, data.interactionId);
    if (event === undefined) return;
    const hookPayload: SubagentInputRequestHookPayload = {
      callId: state.callId,
      childContinuationToken: ctx.ctx.require(ContinuationTokenKey),
      childSessionId: ctx.ctx.require(SessionIdKey),
      childSessionInbox: ctx.ctx.get(SessionInboxKey),
      inputSource: ctx.inputSource,
      event,
      kind: "subagent-input-request",
      subagentName: state.subagentName,
    };
    await forwardSubagentInputRequestStep({
      hookPayload,
      parentContinuationToken: state.parentContinuationToken,
    });
  },
  async "interaction.settled"(data, ctx) {
    await forwardFact({ data, type: "interaction.settled" }, ctx);
  },
  async "response.settled"(data, ctx) {
    await forwardFact({ data, type: "response.settled" }, ctx);
  },
});

async function forwardFact(event: SessionEvent, ctx: FactHandlerContext): Promise<void> {
  const relayed = relayedInteractionEvent(ctx.view, event);
  if (relayed !== undefined) await forwardRelayed(relayed, ctx);
}

async function forwardRelayed(
  event: SubagentAuthorizationEvent,
  ctx: FactHandlerContext,
): Promise<void> {
  await forwardSubagentAuthorizationEvent(event, ctx);
}

async function forwardSubagentAuthorizationEvent(
  event: SubagentAuthorizationEvent,
  ctx: FactHandlerContext,
): Promise<void> {
  const state = ctx.state;

  if (!isSubagentAdapterState(state)) {
    return;
  }

  await forwardSubagentAuthorizationEventStep({
    hookPayload: {
      callId: state.callId,
      childSessionId: ctx.ctx.require(SessionIdKey),
      event,
      kind: "subagent-authorization-event",
      subagentName: state.subagentName,
    },
    parentContinuationToken: state.parentContinuationToken,
  });
}

/** Forwards one child authorization event to its active parent turn. */
async function forwardSubagentAuthorizationEventStep(input: {
  readonly hookPayload: SubagentAuthorizationEventHookPayload;
  readonly parentContinuationToken: string;
}): Promise<void> {
  "use step";

  try {
    await resumeParentHook(input.parentContinuationToken, input.hookPayload);
  } catch (error) {
    const errorId = createErrorId();
    log.warn("failed to forward subagent authorization event to parent", {
      callId: input.hookPayload.callId,
      childSessionId: input.hookPayload.childSessionId,
      errorId,
      eventType: input.hookPayload.event.type,
      parentContinuationToken: input.parentContinuationToken,
      subagentName: input.hookPayload.subagentName,
      error,
    });
    throw error;
  }
}

/**
 * Forwards one child HITL batch up to its parent via the durable
 * workflow `resumeHook` path.
 */
async function forwardSubagentInputRequestStep(input: {
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly parentContinuationToken: string;
}): Promise<void> {
  "use step";

  try {
    await resumeParentHook(input.parentContinuationToken, input.hookPayload);
  } catch (error) {
    const errorId = createErrorId();
    log.warn("failed to forward proxied HITL batch to parent", {
      callId: input.hookPayload.callId,
      childContinuationToken: input.hookPayload.childContinuationToken,
      childSessionId: input.hookPayload.childSessionId,
      errorId,
      parentContinuationToken: input.parentContinuationToken,
      subagentName: input.hookPayload.subagentName,
      error,
    });
    throw error;
  }
}

/**
 * Resumes the parent's hook. The workflow runtime loads only when a child forwards, so the
 * channel adapters every session context restores stay free of it.
 */
async function resumeParentHook(token: string, payload: unknown): Promise<void> {
  const { resumeHook } = await import("#internal/workflow/runtime.js");
  await resumeHook(token, payload);
}
