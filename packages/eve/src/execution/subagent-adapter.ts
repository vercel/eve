import { resumeHook } from "#internal/workflow/runtime.js";

import type { ChannelAdapter, ChannelAdapterContext } from "#channel/adapter.js";
import type {
  SubagentAuthorizationEvent,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { ContinuationTokenKey, SessionIdKey } from "#context/keys.js";
import { createErrorId, createLogger } from "#internal/logging.js";
import { isSandboxStateValue, type SandboxStateValue } from "#sandbox/state.js";

const log = createLogger("execution.subagent-adapter");

/**
 * Durable adapter kind used for delegated subagent child runs.
 *
 * Framework-owned — authored channel code never constructs a subagent
 * adapter directly. Emitted by `buildSubagentRunInput`
 * (`execution/subagent-tool.ts`) when a parent dispatches a child
 * subagent.
 */
export const SUBAGENT_ADAPTER_KIND = "subagent";

/**
 * Durable state carried on a subagent adapter instance.
 *
 * Populated by `buildSubagentRunInput` at dispatch time so the child
 * run retains the parent lineage metadata required to resume its parent
 * when the child finishes and to forward HITL requests up the chain.
 *
 * The parent's turn identifier is not duplicated here — it lives on
 * `RunInput.parent.turn.id` which is the single source of truth for the
 * child's parent-turn lineage.
 */
export interface SubagentAdapterState extends Record<string, unknown> {
  readonly callId: string;
  readonly parentSandboxState?: SandboxStateValue;
  readonly parentContinuationToken: string;
  readonly parentSessionId: string;
  readonly rootSandboxState?: SandboxStateValue;
  readonly subagentName: string;
}

/**
 * Narrow runtime guard for {@link SubagentAdapterState}.
 *
 * Framework adapters live through a JSON round-trip at every workflow
 * step boundary, so consumers that want to treat the adapter state as
 * a structured record must validate the shape explicitly.
 */
export function isSubagentAdapterState(value: unknown): value is SubagentAdapterState {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<SubagentAdapterState>;

  return (
    typeof state.callId === "string" &&
    state.callId.length > 0 &&
    (state.parentSandboxState === undefined || isSandboxStateValue(state.parentSandboxState)) &&
    typeof state.parentContinuationToken === "string" &&
    state.parentContinuationToken.length > 0 &&
    typeof state.parentSessionId === "string" &&
    (state.rootSandboxState === undefined || isSandboxStateValue(state.rootSandboxState)) &&
    typeof state.subagentName === "string" &&
    state.subagentName.length > 0
  );
}

/**
 * Reads the validated parent and root sandbox state carried by a subagent
 * adapter. Other channel adapters do not carry sandbox ancestry.
 */
export function readSubagentSandboxAncestorStates(adapter: ChannelAdapter | undefined): {
  readonly parentState?: SandboxStateValue;
  readonly rootState?: SandboxStateValue;
} {
  if (adapter?.kind !== SUBAGENT_ADAPTER_KIND) {
    return {};
  }

  const state =
    adapter.state !== null && typeof adapter.state === "object" ? adapter.state : undefined;
  const parentState = state?.parentSandboxState;
  const rootState = state?.rootSandboxState;
  if (
    (parentState !== undefined && !isSandboxStateValue(parentState)) ||
    (rootState !== undefined && !isSandboxStateValue(rootState))
  ) {
    throw new TypeError("Invalid sandbox ancestry in subagent adapter state.");
  }
  const ancestry: {
    parentState?: SandboxStateValue;
    rootState?: SandboxStateValue;
  } = {};
  if (parentState !== undefined) {
    ancestry.parentState = parentState;
  }
  if (rootState !== undefined) {
    ancestry.rootState = rootState;
  }
  return ancestry;
}

/**
 * Framework adapter that bridges a child subagent session to its
 * parent.
 *
 * It proxies child `input.requested` events upward so the parent channel
 * can render HITL prompts and route responses back down to the child.
 */
export const SUBAGENT_ADAPTER: ChannelAdapter = {
  kind: SUBAGENT_ADAPTER_KIND,
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
