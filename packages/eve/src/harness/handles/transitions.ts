import {
  AGENT_HANDLES_STATE_KEY,
  assertPersistableAgentHandleStore,
  formatAgentStatus,
  getAgentHandleStore,
  type AgentAddress,
  type AgentHandle,
  type AgentIdentity,
  type ContinueOperation,
  type StartOperation,
} from "#harness/handles/store.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";
import { jsonValuesEqual } from "#shared/json.js";

/**
 * Records intent to start a fresh child. Must be applied to the step's
 * working snapshot before the start side effect runs, so the returned state
 * owns any child the step may have created.
 *
 * The guarantee is intra-step, not exactly-once: the prepared handle
 * durably commits only when the enclosing dispatch step's result commits.
 * A crash between an accepted start and that commit replays the step from
 * the pre-step snapshot and re-runs the side effect.
 *
 * Throws when the identity or operation already exists: fresh starts mint
 * a new identity, so a collision means corrupted derivation, not a replay.
 */
export function prepareAgentStart(
  session: HarnessSession,
  input: {
    readonly identity: AgentIdentity;
    readonly operation: StartOperation;
    readonly target: AgentStartTargetInput;
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  if (handles.some((handle) => handle.identity.id === input.identity.id)) {
    throw new Error(`Agent handle "${input.identity.id}" already exists.`);
  }
  return writeHandles(session, [
    ...handles,
    {
      identity: input.identity,
      operation: input.operation,
      phase: "starting",
      target: input.target,
    },
  ]);
}

type AgentStartTargetInput = Extract<AgentHandle, { phase: "starting" }>["target"];

/** Result of preparing a continuation against an existing handle. */
export type PrepareAgentContinuationResult =
  | {
      readonly kind: "ready";
      readonly session: HarnessSession;
      readonly handle: Extract<AgentHandle, { phase: "running" }>;
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "mismatch" }
  | { readonly kind: "busy" };

/**
 * Records intent to deliver a follow-up turn to a parked child. Must be
 * applied to the step's working snapshot before the delivery side effect
 * runs.
 *
 * Delivery is at-least-once, not exactly-once: the `running` handle durably
 * commits only when the enclosing dispatch step's result commits. If the
 * step dies after a successful delivery, replay starts from `parked` and
 * delivers the same operation again — which is why replaying the operation
 * already recorded on a running handle returns `ready` with the unchanged
 * session instead of a busy conflict.
 *
 * `unknown`, `mismatch`, and `busy` do not change the session; the caller
 * maps them onto `AGENT_UNREACHABLE`, `AGENT_MISMATCH`, and `AGENT_BUSY`
 * results.
 */
export function prepareAgentContinuation(
  session: HarnessSession,
  input: {
    readonly agentId: string;
    readonly execution?: "background" | "blocking";
    readonly invokedName: string;
    readonly operation: ContinueOperation;
    readonly targetKind?: "local" | "remote";
  },
): PrepareAgentContinuationResult {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = handles.find((handle) => handle.identity.id === input.agentId);
  if (existing === undefined) {
    return { kind: "unknown" };
  }
  if (
    existing.identity.name !== input.invokedName ||
    (input.execution !== undefined && existing.identity.execution !== input.execution) ||
    (input.targetKind !== undefined && existing.identity.targetKind !== input.targetKind)
  ) {
    return { kind: "mismatch" };
  }
  if (existing.phase === "running" && existing.operation.id === input.operation.id) {
    return { handle: existing, kind: "ready", session };
  }
  if (existing.phase !== "parked") {
    return { kind: "busy" };
  }

  const running: Extract<AgentHandle, { phase: "running" }> = {
    address: existing.address,
    identity: existing.identity,
    operation: { ...input.operation, previousStatus: existing.lastStatus },
    phase: "running",
  };
  return {
    handle: running,
    kind: "ready",
    session: writeHandles(
      session,
      handles.map((handle) => (handle.identity.id === input.agentId ? running : handle)),
    ),
  };
}

type ActiveAgentHandle = Extract<AgentHandle, { phase: "starting" | "running" }>;

function findActiveHandle(
  handles: readonly AgentHandle[],
  operationId: string,
): ActiveAgentHandle | undefined {
  return handles.find(
    (handle): handle is ActiveAgentHandle =>
      (handle.phase === "starting" || handle.phase === "running") &&
      handle.operation.id === operationId,
  );
}

/**
 * Confirms a started child: `starting` becomes `running` with the child's
 * confirmed address. Throws when no starting handle carries the operation,
 * because confirming an unprepared start means ownership was never
 * committed. Re-confirming an already-running handle with the same
 * operation and address is a replay no-op.
 */
export function confirmAgentStarted(
  session: HarnessSession,
  input: {
    readonly operationId: string;
    readonly address: AgentAddress;
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = findActiveHandle(handles, input.operationId);
  if (existing === undefined) {
    throw new Error(`No prepared agent handle for operation "${input.operationId}".`);
  }
  if (existing.phase === "running") {
    return session;
  }

  return writeHandles(
    session,
    handles.map((handle) =>
      handle === existing
        ? {
            address: input.address,
            identity: existing.identity,
            operation: existing.operation,
            phase: "running",
          }
        : handle,
    ),
  );
}

/** Confirms a task-mode child as a persistent identity/address record. */
export function confirmTaskAgentAddress(
  session: HarnessSession,
  input: {
    readonly operationId: string;
    readonly address: AgentAddress;
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = findActiveHandle(handles, input.operationId);
  if (existing === undefined) {
    throw new Error(`No prepared agent handle for operation "${input.operationId}".`);
  }
  if (existing.phase === "running") {
    throw new Error(
      `Task agent operation "${input.operationId}" was confirmed as a running handle.`,
    );
  }

  return writeHandles(
    session,
    handles.map((handle) =>
      handle === existing
        ? {
            address: input.address,
            identity: existing.identity,
            phase: "addressed" as const,
          }
        : handle,
    ),
  );
}

/**
 * Records a task-mode child's persistent address from its durable executor
 * binding, applied when the parent step that delegated the task commits.
 *
 * Replay-idempotent: a record identical to the stored handle is a no-op
 * (a resumed child, or a replayed commit). A different record under the
 * same id throws — ids derive from unique operations, so a collision
 * means corrupted derivation, not a replay.
 */
export function recordTaskAgentAddress(
  session: HarnessSession,
  input: {
    readonly address: AgentAddress;
    readonly identity: AgentIdentity;
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const targetKind = input.address.kind === "agent/remote" ? "remote" : "local";
  const record: AgentHandle = {
    address: input.address,
    identity: {
      ...input.identity,
      execution: input.identity.execution ?? "background",
      targetKind: input.identity.targetKind ?? targetKind,
    },
    phase: "addressed",
  };
  const existing = handles.find((handle) => handle.identity.id === input.identity.id);
  if (existing !== undefined) {
    if (jsonValuesEqual(existing, record)) return session;
    throw new Error(`Agent handle "${input.identity.id}" already exists with different content.`);
  }
  return writeHandles(session, [...handles, record]);
}

/** Removes a task-mode address after permanent delivery failure. */
export function removeTaskAgentAddress(session: HarnessSession, agentId: string): HarnessSession {
  return { ...session, state: removeTaskAgentAddressFromState(session.state, agentId) };
}

/** State-only variant used while consuming a terminal task wake. */
export function removeTaskAgentAddressFromState(
  state: SessionStateMap | undefined,
  agentId: string,
): SessionStateMap {
  const handles = getAgentHandleStore(state)?.handles ?? [];
  return {
    ...state,
    [AGENT_HANDLES_STATE_KEY]: assertPersistableAgentHandleStore({
      handles: handles.filter(
        (handle) => !(handle.phase === "addressed" && handle.identity.id === agentId),
      ),
    }),
  };
}

/**
 * Resolves a dispatch that definitively failed.
 *
 * - A dead start or dead continuation deletes the handle: there is no
 *   child left to own.
 * - A retryable continuation failure restores `parked` with the status the
 *   handle showed before the delivery, so the model may retry the same
 *   `agentId` later.
 *
 * Unknown operations are a no-op: the failure raced a settlement that
 * already resolved the handle.
 */
export function rejectAgentEffect(
  session: HarnessSession,
  input: {
    readonly operationId: string;
    readonly disposition: "dead" | "retryable";
  },
): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = findActiveHandle(handles, input.operationId);
  if (existing === undefined) {
    return session;
  }

  if (input.disposition === "retryable" && existing.phase === "running") {
    const { operation } = existing;
    if (operation.kind === "continue") {
      return writeHandles(
        session,
        handles.map((handle) =>
          handle === existing
            ? {
                address: existing.address,
                identity: existing.identity,
                lastStatus: operation.previousStatus,
                phase: "parked",
              }
            : handle,
        ),
      );
    }
  }

  return writeHandles(
    session,
    handles.filter((handle) => handle !== existing),
  );
}

/**
 * Parks every running child when the parent abandons a cancelled turn.
 *
 * Cancellation requests each running descendant's cancellation and then
 * tears down the turn inbox — the only hook a child settlement can
 * resume — so no later settlement can move these handles. Without this
 * transition they would stay `running` forever: invisible to the model,
 * unresumable, and retried by every future cancellation.
 *
 * A cancelled child settles its own turn as a park, so `parked` with
 * `"(cancelled)"` mirrors {@link settleAgentTurn}'s cancelled outcome. If
 * the child instead died, a later continuation attempt discovers the dead
 * session and {@link rejectAgentEffect} deletes the handle.
 */
export function abandonRunningAgentTurns(session: HarnessSession): HarnessSession {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  if (!handles.some((handle) => handle.phase === "running")) {
    return session;
  }
  return writeHandles(
    session,
    handles.map((handle) =>
      handle.phase === "running"
        ? {
            address: handle.address,
            identity: handle.identity,
            lastStatus: "(cancelled)",
            phase: "parked",
          }
        : handle,
    ),
  );
}

/** Result of applying a settled child turn to the store. */
export type SettleAgentTurnResult =
  | { readonly kind: "settled"; readonly session: HarnessSession }
  | { readonly kind: "ignored"; readonly reason: "unknown-operation" };

/**
 * Applies one settled child turn: `running` becomes `parked` for a parked
 * outcome or is deleted for a terminal outcome.
 *
 * The settlement must carry the operation currently recorded on the
 * running handle; anything else is ignored so a stale delivery can never
 * move a newer turn.
 */
export function settleAgentTurn(
  session: HarnessSession,
  input: {
    readonly operationId: string;
    readonly outcome: AgentTurnOutcome;
  },
): SettleAgentTurnResult {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = handles.find(
    (handle) => handle.phase === "running" && handle.operation.id === input.operationId,
  );
  if (existing === undefined || existing.phase !== "running") {
    return { kind: "ignored", reason: "unknown-operation" };
  }

  if (input.outcome.kind === "terminal") {
    return {
      kind: "settled",
      session: writeHandles(
        session,
        handles.filter((handle) => handle !== existing),
      ),
    };
  }

  const { result } = input.outcome;
  const lastStatus =
    result.kind === "succeeded"
      ? formatAgentStatus(result.output)
      : result.kind === "failed"
        ? formatAgentStatus(result.error)
        : "(cancelled)";
  return {
    kind: "settled",
    session: writeHandles(
      session,
      handles.map((handle) =>
        handle === existing
          ? {
              address: existing.address,
              identity: existing.identity,
              lastStatus,
              phase: "parked",
            }
          : handle,
      ),
    ),
  };
}

/**
 * Rebases the handle delta one dispatch produced (`base` → `next`) onto a
 * working session that other concurrently staged effects may have advanced
 * past `base`.
 *
 * Per handle id:
 *
 * - deleted by the dispatch → deleted from the working session.
 * - added by the dispatch → appended. If the working session already holds
 *   the id with different content, throws: ids derive from unique
 *   operations, so a collision means corrupted derivation.
 * - changed in place by the dispatch → the dispatched copy replaces the
 *   working copy while that copy still matches `base`. A working copy that
 *   diverged from both throws instead of silently dropping either change.
 * - untouched by the dispatch → the working copy is kept.
 *
 * A delta the working session already contains is a no-op, so replaying an
 * effect is safe.
 */
export function rebaseAgentHandles(
  session: HarnessSession,
  input: {
    readonly base: SessionStateMap | undefined;
    readonly next: SessionStateMap | undefined;
  },
): HarnessSession {
  const baseById = handlesById(input.base);
  const nextById = handlesById(input.next);
  const currentHandles = getAgentHandleStore(session.state)?.handles ?? [];
  const currentIds = new Set(currentHandles.map((handle) => handle.identity.id));

  let changed = false;
  const rebased: AgentHandle[] = [];
  for (const current of currentHandles) {
    const id = current.identity.id;
    const base = baseById.get(id);
    const next = nextById.get(id);
    if (base !== undefined && next === undefined) {
      changed = true;
      continue;
    }
    if (base === undefined && next !== undefined && !jsonValuesEqual(current, next)) {
      throw new Error(
        `Agent handle "${id}" added by a dispatch already exists with different content.`,
      );
    }
    if (base !== undefined && next !== undefined && !jsonValuesEqual(base, next)) {
      if (jsonValuesEqual(current, base)) {
        rebased.push(next);
        changed = true;
        continue;
      }
      if (!jsonValuesEqual(current, next)) {
        throw new Error(
          `Agent handle "${id}" was changed by a dispatch and concurrently by another effect.`,
        );
      }
    }
    rebased.push(current);
  }
  const added = [...nextById.values()].filter(
    (handle) => !baseById.has(handle.identity.id) && !currentIds.has(handle.identity.id),
  );
  if (!changed && added.length === 0) {
    return session;
  }
  return writeHandles(session, [...rebased, ...added]);
}

function handlesById(state: SessionStateMap | undefined): ReadonlyMap<string, AgentHandle> {
  const handles = getAgentHandleStore(state)?.handles ?? [];
  return new Map(handles.map((handle) => [handle.identity.id, handle]));
}

/**
 * Persists the handle store, validating it against the strict store schema
 * first. This write-time check is what lets the schema-free driver-side
 * reader (`query.ts`) trust any stored value without revalidating: a
 * transition bug fails loudly here instead of poisoning the session for
 * every later read.
 */
function writeHandles(session: HarnessSession, handles: readonly AgentHandle[]): HarnessSession {
  return {
    ...session,
    state: {
      ...session.state,
      [AGENT_HANDLES_STATE_KEY]: assertPersistableAgentHandleStore({ handles }),
    },
  };
}
