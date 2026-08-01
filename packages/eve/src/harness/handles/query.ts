import type {
  ChildSessionClaim,
  RuntimeActionResult,
  RuntimeSubagentChildResult,
} from "#runtime/actions/types.js";
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
 * handle whose recorded operation carries the result's callId and whose
 * confirmed address names the claimed child session. A `call-only` claim
 * (see {@link ChildSessionClaim}) binds by callId alone.
 */
export function findRunningAgentHandle(
  state: SessionStateMap | undefined,
  input: { readonly callId: string; readonly claim: ChildSessionClaim },
): RunningAgentHandle | undefined {
  // Inbox hook payloads are durable: one persisted by an older build during
  // an in-flight deploy may predate the claim field. Such a result is
  // unclaimable and must drop, not throw inside the driver loop.
  const claim = input.claim as ChildSessionClaim | undefined;
  if (claim === undefined) {
    return undefined;
  }
  const handles = readAgentHandles(state);
  return handles.find(
    (handle): handle is RunningAgentHandle =>
      handle.phase === "running" &&
      handle.operation.callId === input.callId &&
      (claim.kind === "call-only" || handle.address.sessionId === claim.sessionId),
  );
}

/**
 * Subagent results arrive through the parent's shared callback hook, which
 * every remote callee in a batch can reach. Dispatch-time ownership is
 * authoritative: a child result may settle a call only when a running handle
 * binds that callId to its claimed session, so one callee cannot forge a
 * sibling's result.
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
  if (result.origin === "dispatch") {
    return true;
  }
  return (
    findRunningAgentHandle(state, { callId: result.callId, claim: result.claim }) !== undefined
  );
}

/**
 * Strict variant of {@link isResultBoundToRunningHandle} for results arriving
 * over the shared turn inbox (child notifications and remote callbacks).
 * Only `child`-origin results ever travel the inbox, and each must bind to a
 * running handle under its claim. A result with no matching running handle —
 * including one for a callId whose dispatch already failed — must not
 * overwrite the dispatch-produced error result, and a `dispatch`-origin
 * result on the inbox is a forgery by definition.
 */
export function isInboxSubagentResultFromRunningHandle(
  state: SessionStateMap | undefined,
  result: RuntimeSubagentChildResult,
): boolean {
  return (
    findRunningAgentHandle(state, { callId: result.callId, claim: result.claim }) !== undefined
  );
}
