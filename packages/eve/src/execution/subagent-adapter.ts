import { resumeHook } from "#internal/workflow/runtime.js";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  SubagentForwardedEvent,
  SubagentForwardedEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import {
  SUBAGENT_ADAPTER_KIND,
  isSubagentAdapterState,
} from "#execution/subagent-adapter-state.js";
import { isSubagentDelegationAction } from "#harness/subagent-depth.js";
import { createErrorId, createLogger } from "#internal/logging.js";

const log = createLogger("execution.subagent-adapter");

/**
 * Framework adapter that bridges a child subagent session to its
 * parent.
 *
 * It proxies child `input.requested` events upward so the parent channel
 * can render HITL prompts and route responses back down to the child, and
 * proxies the child's nested-dispatch lifecycle upward so a parent progress
 * surface sees past its own `subagent-call` into the work the child
 * delegated onward.
 */
export const SUBAGENT_ADAPTER: ChannelAdapter = {
  kind: SUBAGENT_ADAPTER_KIND,
  async "actions.requested"(data, ctx) {
    // Only delegated work is forwarded. A child's own tool calls are per-step
    // chatter with unbounded result payloads, and every hop up the chain
    // replays them into another durable step and another parent stream.
    const actions = data.actions.filter(isSubagentDelegationAction);

    if (actions.length === 0) {
      return;
    }

    await forwardSubagentEvent({ data: { ...data, actions }, type: "actions.requested" }, ctx);
  },
  async "action.result"(data, ctx) {
    if (data.result.kind !== "subagent-result") {
      return;
    }

    await forwardSubagentEvent({ data, type: "action.result" }, ctx);
  },
  async "approval.candidate"(data, ctx) {
    await forwardSubagentEvent({ data, type: "approval.candidate" }, ctx);
  },
  async "approval.settled"(data, ctx) {
    await forwardSubagentEvent({ data, type: "approval.settled" }, ctx);
  },
  async "authorization.required"(data, ctx) {
    await forwardSubagentEvent({ data, type: "authorization.required" }, ctx);
  },
  async "authorization.completed"(data, ctx) {
    await forwardSubagentEvent({ data, type: "authorization.completed" }, ctx);
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

async function forwardSubagentEvent(
  event: SubagentForwardedEvent,
  ctx: ChannelAdapterContext,
): Promise<void> {
  const state = ctx.state;

  if (!isSubagentAdapterState(state)) {
    return;
  }

  await forwardSubagentEventStep({
    hookPayload: {
      callId: state.callId,
      childSessionId: ctx.ctx.require(SessionIdKey),
      event,
      kind: "subagent-forwarded-event",
      subagentName: state.subagentName,
    },
    parentContinuationToken: state.parentContinuationToken,
  });
}

/** Forwards one child stream event to its active parent turn. */
async function forwardSubagentEventStep(input: {
  readonly hookPayload: SubagentForwardedEventHookPayload;
  readonly parentContinuationToken: string;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(input.parentContinuationToken, input.hookPayload);
  } catch (error) {
    const errorId = createErrorId();
    log.warn("failed to forward subagent event to parent", {
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
    await resumeHook(input.parentContinuationToken, input.hookPayload);
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
