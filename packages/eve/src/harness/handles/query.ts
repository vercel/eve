import type { RuntimeActionResult } from "#runtime/actions/types.js";
import { getAgentHandleStore, type AgentHandle } from "#harness/handles/store.js";
import type { SessionStateMap } from "#harness/types.js";

/** A handle with one outstanding operation and a confirmed child address. */
export type RunningAgentHandle = Extract<AgentHandle, { phase: "running" }>;

/**
 * Finds the running agent handle a child-produced result must settle: the
 * handle whose recorded operation carries the result's callId and whose
 * confirmed address names the claiming child session.
 */
export function findRunningAgentHandle(
  state: SessionStateMap | undefined,
  input: { readonly callId: string; readonly sessionId: string },
): RunningAgentHandle | undefined {
  const handles = getAgentHandleStore(state)?.handles ?? [];
  return handles.find(
    (handle): handle is RunningAgentHandle =>
      handle.phase === "running" &&
      handle.operation.callId === input.callId &&
      handle.address.sessionId === input.sessionId,
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
 * Every legitimate inbox subagent result comes from a dispatched child that
 * claims its own session, so a result without a matching running handle —
 * including one for a callId whose dispatch already failed — is forged and
 * must not overwrite the dispatch-produced error result.
 */
export function isInboxResultFromRunningHandle(
  state: SessionStateMap | undefined,
  result: RuntimeActionResult,
): boolean {
  if (result.kind !== "subagent-result") {
    return true;
  }
  if (result.sessionId === undefined) {
    return false;
  }
  return (
    findRunningAgentHandle(state, { callId: result.callId, sessionId: result.sessionId }) !==
    undefined
  );
}
