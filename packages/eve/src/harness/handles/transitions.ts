import {
  formatAgentStatus,
  getAgentHandleStore,
  setAgentHandleStore,
  type AgentAddress,
  type AgentHandle,
  type AgentHandleStore,
  type AgentHandleStoreCommand,
  type AgentHandleStoreCommandResult,
  type AgentIdentity,
  type ContinueOperation,
  type StartOperation,
  type TaskOwnedAgentHandle,
} from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import type { AgentTurnOutcome } from "#shared/agent-turn-outcome.js";

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
    readonly invokedName: string;
    readonly operation: ContinueOperation;
  },
): PrepareAgentContinuationResult {
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const existing = handles.find((handle) => handle.identity.id === input.agentId);
  if (existing === undefined) {
    return { kind: "unknown" };
  }
  if (existing.identity.name !== input.invokedName) {
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

/** Applies one atomic task lease command to the shared agent handle store. */
export function applyAgentHandleStoreCommand(
  store: AgentHandleStore,
  command: AgentHandleStoreCommand,
): {
  readonly result: AgentHandleStoreCommandResult;
  readonly store: AgentHandleStore;
} {
  switch (command.kind) {
    case "read":
      return { result: { kind: "ready" }, store };
    case "reserve": {
      const existing = store.handles.find((handle) => handle.identity.id === command.identity.id);
      if (existing !== undefined) {
        return (existing.phase === "reserved" || existing.phase === "claimed") &&
          existing.operationId === command.operationId &&
          existing.taskId === command.taskId
          ? { result: { handle: existing, kind: "ready" }, store }
          : { result: { handle: existing, kind: "busy" }, store };
      }
      const handle: TaskOwnedAgentHandle = {
        identity: command.identity,
        operationId: command.operationId,
        phase: "reserved",
        taskId: command.taskId,
      };
      return {
        result: { handle, kind: "ready" },
        store: { handles: [...store.handles, handle] },
      };
    }
    case "confirm": {
      const existing = store.handles.find(
        (
          handle,
        ): handle is Extract<TaskOwnedAgentHandle, { readonly phase: "claimed" | "reserved" }> =>
          (handle.phase === "claimed" || handle.phase === "reserved") &&
          handle.operationId === command.operationId &&
          handle.taskId === command.taskId,
      );
      if (existing === undefined) return { result: { kind: "unknown" }, store };
      if (existing.phase === "claimed") {
        return { result: { handle: existing, kind: "ready" }, store };
      }
      const handle: TaskOwnedAgentHandle = {
        address: command.address,
        identity: existing.identity,
        operationId: existing.operationId,
        phase: "claimed",
        taskId: existing.taskId,
      };
      return replaceHandle(store, existing, handle);
    }
    case "claim": {
      const existing = store.handles.find((handle) => handle.identity.id === command.agentId);
      if (existing === undefined) return { result: { kind: "unknown" }, store };
      if (
        existing.phase === "starting" ||
        existing.phase === "running" ||
        existing.phase === "parked" ||
        existing.identity.name !== command.invokedName ||
        (existing.phase !== "reserved" &&
          (existing.address.kind === "agent/remote") !== (command.expectedTarget === "remote"))
      ) {
        return { result: { handle: existing, kind: "mismatch" }, store };
      }
      if (existing.phase === "claimed") {
        return existing.operationId === command.operationId && existing.taskId === command.taskId
          ? { result: { handle: existing, kind: "ready" }, store }
          : { result: { handle: existing, kind: "busy" }, store };
      }
      if (existing.phase === "reserved") {
        return { result: { handle: existing, kind: "busy" }, store };
      }
      const handle: TaskOwnedAgentHandle = {
        address: existing.address,
        identity: existing.identity,
        operationId: command.operationId,
        phase: "claimed",
        taskId: command.taskId,
      };
      return replaceHandle(store, existing, handle);
    }
    case "remove": {
      const existing = store.handles.find((handle) => handle.identity.id === command.agentId);
      if (existing === undefined) return { result: { kind: "ready" }, store };
      if (existing.phase === "claimed" && existing.taskId !== command.taskId) {
        return { result: { handle: existing, kind: "busy" }, store };
      }
      return {
        result: { kind: "ready" },
        store: { handles: store.handles.filter((handle) => handle !== existing) },
      };
    }
    case "release-task": {
      const handles = store.handles.flatMap((handle): readonly AgentHandle[] => {
        if (handle.phase === "reserved" && handle.taskId === command.taskId) return [];
        if (handle.phase !== "claimed" || handle.taskId !== command.taskId) return [handle];
        return [{ address: handle.address, identity: handle.identity, phase: "available" }];
      });
      return {
        result: { kind: "ready" },
        store: handlesEqual(store.handles, handles) ? store : { handles },
      };
    }
  }
}

function replaceHandle(
  store: AgentHandleStore,
  existing: AgentHandle,
  handle: TaskOwnedAgentHandle,
): {
  readonly result: AgentHandleStoreCommandResult;
  readonly store: AgentHandleStore;
} {
  return {
    result: { handle, kind: "ready" },
    store: {
      handles: store.handles.map((candidate) => (candidate === existing ? handle : candidate)),
    },
  };
}

function handlesEqual(left: readonly AgentHandle[], right: readonly AgentHandle[]): boolean {
  return left.length === right.length && left.every((handle, index) => handle === right[index]);
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
    state: setAgentHandleStore(session.state, { handles }),
  };
}
