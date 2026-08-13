import { resumeHook } from "#internal/workflow/runtime.js";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
  SubagentProgressEvent,
  SubagentProgressEventHookPayload,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import {
  SUBAGENT_ADAPTER_KIND,
  isSubagentAdapterState,
} from "#execution/subagent-adapter-state.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";

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
    const actions = data.actions.filter(isDispatchActionRequest);

    if (actions.length === 0) {
      return;
    }

    await forwardSubagentProgressEvent(
      { data: { ...data, actions }, type: "actions.requested" },
      ctx,
    );
  },
  async "action.result"(data, ctx) {
    if (data.result.kind !== "subagent-result") {
      return;
    }

    await forwardSubagentProgressEvent({ data, type: "action.result" }, ctx);
  },
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

/**
 * Nested dispatch is the unit a parent progress surface can render: it is the
 * child's own `subagent.called` boundary, one event per delegated run. A
 * child's tool calls are per-step chatter with unbounded result payloads, and
 * every hop up the chain replays them into another durable step and another
 * parent stream.
 */
function isDispatchActionRequest(action: RuntimeActionRequest): boolean {
  return action.kind === "remote-agent-call" || action.kind === "subagent-call";
}

async function forwardSubagentProgressEvent(
  event: SubagentProgressEvent,
  ctx: ChannelAdapterContext,
): Promise<void> {
  const state = ctx.state;

  if (!isSubagentAdapterState(state)) {
    return;
  }

  await forwardSubagentProgressEventStep({
    hookPayload: {
      callId: state.callId,
      childSessionId: ctx.ctx.require(SessionIdKey),
      event,
      kind: "subagent-progress-event",
      subagentName: state.subagentName,
    },
    parentContinuationToken: state.parentContinuationToken,
  });
}

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

/** Forwards one child nested-dispatch event to its active parent turn. */
async function forwardSubagentProgressEventStep(input: {
  readonly hookPayload: SubagentProgressEventHookPayload;
  readonly parentContinuationToken: string;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(input.parentContinuationToken, input.hookPayload);
  } catch (error) {
    const errorId = createErrorId();
    log.warn("failed to forward subagent progress event to parent", {
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

/** Forwards one child authorization event to its active parent turn. */
async function forwardSubagentAuthorizationEventStep(input: {
  readonly hookPayload: SubagentAuthorizationEventHookPayload;
  readonly parentContinuationToken: string;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(input.parentContinuationToken, input.hookPayload);
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
