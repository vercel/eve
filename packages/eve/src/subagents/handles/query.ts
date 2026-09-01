import type { RuntimeActionResult, RuntimeSubagentChildResult } from "#shared/action-types.js";
import { AGENT_HANDLES_STATE_KEY } from "#subagents/handles/state-key.js";
import type { AgentHandle, AgentHandleStore } from "#subagents/handles/store.js";
import type { SessionStateMap } from "#harness/types.js";

/** A handle with one outstanding operation and a confirmed child address. */
export type RunningAgentHandle = Extract<AgentHandle, { phase: "running" }>;

/**
 * Schema-free read of the agent handles from session state.
 *
 * Trust boundary: every source store was validated by a handle transition.
 * Driver-side reads and ownership merges trust that invariant instead of
 * re-validating, so the workflow driver bundle stays free of compiled zod.
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
 * Rebases task-owned handle mutations accepted by the session driver while a
 * turn was running onto that turn's returned state.
 *
 * The turn owns `starting`/`running`/`parked`; stable-inbox commands own
 * `reserved`/`claimed`/`available`. Replacing only the latter prevents the
 * turn's older snapshot from erasing a concurrently accepted task lease while
 * preserving any ordinary handle transition the turn itself committed.
 */
export function mergeTaskOwnedAgentHandlesIntoTurnState(input: {
  readonly driverState: SessionStateMap | undefined;
  readonly turnState: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const driverStore = readAgentHandleStore(input.driverState);
  if (driverStore === undefined) return input.turnState;

  const taskHandles = new Map(
    driverStore.handles
      .filter(isTaskOwnedAgentHandle)
      .map((handle) => [handle.identity.id, handle] as const),
  );
  const merged: AgentHandle[] = [];
  for (const handle of readAgentHandles(input.turnState)) {
    if (isTaskOwnedAgentHandle(handle)) {
      const current = taskHandles.get(handle.identity.id);
      if (current !== undefined) {
        merged.push(current);
        taskHandles.delete(handle.identity.id);
      }
      continue;
    }
    if (taskHandles.has(handle.identity.id)) {
      throw new Error(
        `Agent handle "${handle.identity.id}" changed ownership while its turn was running.`,
      );
    }
    merged.push(handle);
  }
  for (const handle of taskHandles.values()) {
    if (merged.some((candidate) => candidate.identity.id === handle.identity.id)) {
      throw new Error(
        `Agent handle "${handle.identity.id}" changed ownership while its turn was running.`,
      );
    }
    merged.push(handle);
  }

  return {
    ...input.turnState,
    [AGENT_HANDLES_STATE_KEY]: { handles: merged } satisfies AgentHandleStore,
  };
}

function readAgentHandleStore(state: SessionStateMap | undefined): AgentHandleStore | undefined {
  if (state?.[AGENT_HANDLES_STATE_KEY] === undefined) return undefined;
  return { handles: readAgentHandles(state) };
}

function isTaskOwnedAgentHandle(
  handle: AgentHandle,
): handle is Extract<AgentHandle, { phase: "available" | "claimed" | "reserved" }> {
  return handle.phase === "available" || handle.phase === "claimed" || handle.phase === "reserved";
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
