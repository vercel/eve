import type { RuntimeActionResult, RuntimeSubagentChildResult } from "#runtime/actions/types.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/state-key.js";
import type { AgentHandle } from "#harness/handles/store.js";
import type { SessionStateMap } from "#harness/types.js";

/** A handle with one outstanding operation and a confirmed child address. */
export type RunningAgentHandle = Extract<AgentHandle, { phase: "running" }>;

/**
 * Schema-free read of the agent handles from session state.
 *
 * Trust boundary: every write to this key goes through `writeHandles` in
 * transitions.ts, which runs the strict zod store schema at persist time and
 * refuses to write an invalid store. This driver-side query trusts that
 * invariant instead of re-validating, so the workflow driver bundle stays
 * free of the compiled zod runtime.
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
 * handle whose recorded operation carries the result's callId.
 *
 * Binding is by callId alone. Possession of the parent's callback token is
 * the authorization to settle; the handle's recorded address is used for
 * outbound delivery (continuation, cancellation), never as an inbound
 * identity check. Under the accepted at-least-once dispatch window a
 * replay-orphaned duplicate child holds the same token and callId and may
 * settle the call in place of the owned child — an accepted trade-off,
 * since both children computed the same input.
 */
export function findRunningAgentHandle(
  state: SessionStateMap | undefined,
  input: { readonly callId: string },
): RunningAgentHandle | undefined {
  const handles = readAgentHandles(state);
  return handles.find(
    (handle): handle is RunningAgentHandle =>
      handle.phase === "running" && handle.operation.callId === input.callId,
  );
}

/**
 * A subagent result may settle a call only when a running handle records
 * its callId: a late or duplicate result for an already-settled call finds
 * no running handle and is dropped.
 *
 * `dispatch`-origin failures pass unconditionally: the parent synthesizes
 * them for calls whose child never started, and they reach the harness only
 * through the trusted step-result path. Untrusted channels must use
 * {@link isInboxSubagentResultFromRunningHandle} instead.
 */
export function isResultBoundToRunningHandle(
  state: SessionStateMap | undefined,
  result: RuntimeActionResult,
): boolean {
  if (result.kind !== "subagent-result") {
    return true;
  }
  if (result.origin === "dispatch" || result.backgroundTask !== undefined) {
    return true;
  }
  return findRunningAgentHandle(state, { callId: result.callId }) !== undefined;
}

/**
 * Strict variant of {@link isResultBoundToRunningHandle} for results arriving
 * over the shared turn inbox (child notifications and remote callbacks).
 * An inbox result must bind to a running handle by callId; one with no
 * matching running handle — including one for a callId whose dispatch
 * already failed — must not overwrite the dispatch-produced error result.
 */
export function isInboxSubagentResultFromRunningHandle(
  state: SessionStateMap | undefined,
  result: RuntimeSubagentChildResult,
): boolean {
  return findRunningAgentHandle(state, { callId: result.callId }) !== undefined;
}
