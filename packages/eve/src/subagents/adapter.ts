import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey, SessionInboxKey } from "#context/keys.js";
import { resolvedForParent } from "#harness/proxy-input-requests.js";
import { SUBAGENT_ADAPTER_KIND, isSubagentAdapterState } from "#subagents/adapter-state.js";
import { createErrorId, createLogger } from "#internal/logging.js";

const log = createLogger("execution.subagent-adapter");

/**
 * Framework adapter that bridges a child subagent session to its
 * parent.
 *
 * It proxies child `input.requested` events upward so the parent channel can
 * render HITL prompts and route responses back down to the child, and the
 * `input.resolved` of requests only the child can close.
 */
export const SUBAGENT_ADAPTER: ChannelAdapter = {
  kind: SUBAGENT_ADAPTER_KIND,
  async "approval.candidate"(data, ctx) {
    await forwardSubagentAuthorizationEvent({ data, type: "approval.candidate" }, ctx);
  },
  async "approval.settled"(data, ctx) {
    await forwardSubagentAuthorizationEvent({ data, type: "approval.settled" }, ctx);
  },
  async "authorization.required"(data, ctx) {
    await forwardSubagentAuthorizationEvent({ data, type: "authorization.required" }, ctx);
  },
  async "authorization.completed"(data, ctx) {
    await forwardSubagentAuthorizationEvent({ data, type: "authorization.completed" }, ctx);
  },
  async "input.resolved"(data, ctx) {
    const relayed = resolvedForParent(data);
    if (relayed === undefined) return;
    await forwardSubagentAuthorizationEvent({ data: relayed, type: "input.resolved" }, ctx);
  },
  async "input.requested"(data, ctx) {
    const state = ctx.state;

    if (!isSubagentAdapterState(state)) {
      return;
    }

    const hookPayload: SubagentInputRequestHookPayload = {
      callId: state.callId,
      childContinuationToken: ctx.ctx.require(ContinuationTokenKey),
      childSessionId: ctx.ctx.require(SessionIdKey),
      childSessionInbox: ctx.ctx.get(SessionInboxKey),
      inputSource: ctx.inputSource,
      event: {
        requests: data.requests,
        sequence: data.sequence,
        stepIndex: data.stepIndex,
        turnId: data.turnId,
      },
      kind: "subagent-input-request",
      subagentName: state.subagentName,
    };

    await forwardSubagentInputRequestStep({
      hookPayload,
      parentContinuationToken: state.parentContinuationToken,
    });
  },
};

async function forwardSubagentAuthorizationEvent(
  event: SubagentAuthorizationEvent,
  ctx: ChannelAdapterContext,
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
