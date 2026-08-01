import type { RuntimeActionResult } from "#runtime/actions/types.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/state-key.js";
import type { AgentHandle } from "#harness/handles/store.js";
import type { SessionStateMap } from "#harness/types.js";

/** A handle with one outstanding operation and a confirmed child address. */
export type RunningAgentHandle = Extract<AgentHandle, { phase: "running" }>;

/**
 * Schema-free read of the agent handles from session state.
 *
 * Trust boundary: every write to this key goes through transitions.ts, which
 * validates against the strict zod store schema before persisting. This
 * driver-side query trusts that invariant instead of re-validating, so the
 * workflow driver bundle stays free of the compiled zod runtime.
 */
function readAgentHandles(state: SessionStateMap | undefined): readonly AgentHandle[] {
  const raw = state?.[AGENT_HANDLES_STATE_KEY];
  if (raw === undefined) {
    return [];
  }
  const handles = (raw as { handles?: unknown }).handles;
  return Array.isArray(handles) ? (handles as readonly AgentHandle[]) : [];
}

/**
 * Finds the running agent handle a child-produced result must settle: the
 * handle whose recorded operation carries the result's callId and whose
 * confirmed address names the claiming child session. Results from older
 * eve deployments carry no sessionId and bind by callId alone.
 */
export function findRunningAgentHandle(
  state: SessionStateMap | undefined,
  input: { readonly callId: string; readonly sessionId: string | undefined },
): RunningAgentHandle | undefined {
  const handles = readAgentHandles(state);
  return handles.find(
    (handle): handle is RunningAgentHandle =>
      handle.phase === "running" &&
      handle.operation.callId === input.callId &&
      (input.sessionId === undefined || handle.address.sessionId === input.sessionId),
  );
}

/**
 * Subagent results arrive through the parent's shared callback hook, which
 * every remote callee in a batch can reach. Dispatch-time ownership is
 * authoritative: a result claiming a child `sessionId` may settle a call
 * only when a running handle binds that callId to that session, so one
 * callee cannot forge a sibling's result.
 *
 * Results without a `sessionId` pass: the dispatch step synthesizes error
 * results for calls whose child never started, and those reach the harness
 * through the trusted step-result path where they bind by callId. Untrusted
 * channels must use {@link isInboxResultFromRunningHandle} instead.
 */
export function isResultBoundToRunningHandle(
  state: SessionStateMap | undefined,
  result: RuntimeActionResult,
): boolean {
  if (result.kind !== "subagent-result") {
    return true;
  }
  if (result.sessionId === undefined) {
    return true;
  }
  return (
    findRunningAgentHandle(state, { callId: result.callId, sessionId: result.sessionId }) !==
    undefined
  );
}

/**
 * Strict variant of {@link isResultBoundToRunningHandle} for results arriving
 * over the shared turn inbox (child notifications and remote callbacks).
 * An inbox subagent result must bind to a running handle: when it claims a
 * sessionId the handle's address must match it, and when it carries none
 * (older eve deployments) the callId alone must name a running handle. A
 * result with no matching running handle — including one for a callId whose
 * dispatch already failed — must not overwrite the dispatch-produced error
 * result.
 */
export function isInboxResultFromRunningHandle(
  state: SessionStateMap | undefined,
  result: RuntimeActionResult,
): boolean {
  if (result.kind !== "subagent-result") {
    return true;
  }
  return (
    findRunningAgentHandle(state, { callId: result.callId, sessionId: result.sessionId }) !==
    undefined
  );
}
