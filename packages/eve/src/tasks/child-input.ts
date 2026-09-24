import { resumeHook } from "#internal/workflow/runtime.js";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey, SessionInboxKey } from "#context/keys.js";
import { SUBAGENT_ADAPTER_KIND, isSubagentAdapterState } from "#subagents/adapter-state.js";
import { createErrorId, createLogger } from "#internal/logging.js";

const log = createLogger("execution.subagent-adapter");

/**
 * The channel adapter of a local task child: it reports the child's input
 * requests and authorization events to its owner, so the owner's channel can
 * render them and route answers back down to the child.
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
      event: {
        requests: data.requests,
        sequence: data.sequence,
        stepIndex: data.stepIndex,
        turnId: data.turnId,
      },
      kind: "subagent-input-request",
      subagentName: state.subagentName,
    };

    await forwardToParentStep({
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

  await forwardToParentStep({
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

/**
 * Forwards one child input batch or authorization event to its parent's
 * active turn via the durable workflow `resumeHook` path.
 */
async function forwardToParentStep(input: {
  readonly hookPayload: SubagentAuthorizationEventHookPayload | SubagentInputRequestHookPayload;
  readonly parentContinuationToken: string;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(input.parentContinuationToken, input.hookPayload);
  } catch (error) {
    const { hookPayload } = input;
    const fields = {
      callId: hookPayload.callId,
      childSessionId: hookPayload.childSessionId,
      errorId: createErrorId(),
      parentContinuationToken: input.parentContinuationToken,
      subagentName: hookPayload.subagentName,
      error,
    };
    if (hookPayload.kind === "subagent-authorization-event") {
      log.warn("failed to forward subagent authorization event to parent", {
        ...fields,
        eventType: hookPayload.event.type,
      });
    } else {
      log.warn("failed to forward proxied HITL batch to parent", {
        ...fields,
        childContinuationToken: hookPayload.childContinuationToken,
      });
    }
    throw error;
  }
}
