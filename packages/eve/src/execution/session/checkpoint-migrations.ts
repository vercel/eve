import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import { isObject } from "#shared/guards.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { getBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { HITL_STATE_KEYS } from "#harness/hitl/session-state.js";

/**
 * Oldest checkpoint a successor upgrades (eve 0.66.0). Earlier checkpoints
 * predate the sandbox provider and dynamic skill manifest contracts and lack
 * data the current reader requires.
 */
export const MIN_SESSION_CHECKPOINT_VERSION = 8;

export type SessionCheckpointMigration =
  | {
      readonly kind: "current";
      readonly checkpoint: SessionCheckpoint;
      /** Idle child sessions the current build no longer tracks; the successor stops them. */
      readonly childRunIdsToStop: readonly string[];
    }
  | { readonly kind: "incompatible"; readonly detail: string };

type CheckpointRecord = Record<string, unknown>;

interface UpgradeEffects {
  readonly childRunIdsToStop: string[];
}

/**
 * One pure upgrade per checkpoint version, keyed by the version it reads.
 * Bumping `SESSION_CHECKPOINT_VERSION` requires adding the step from the
 * previous version: a successor must always accept its predecessors'
 * checkpoints. A step refuses state the current build cannot continue, such
 * as work still in flight; the owner then keeps the session. Steps cover the
 * shapes released builds wrote.
 */
const CHECKPOINT_UPGRADES: Readonly<
  Record<number, (checkpoint: CheckpointRecord, effects: UpgradeEffects) => CheckpointRecord>
> = {
  // Run mode was removed (eve 0.67).
  8: (checkpoint) => {
    const { mode: _mode, ...rest } = checkpoint;
    return {
      ...rest,
      serializedContext: omitKeys(readRecord(rest, "serializedContext"), ["eve.mode"]),
    };
  },
  // eve 0.69 removed background tasks, subagent handles, activity artifacts, and
  // cached connection search results, and moved protocol-1 caller detection.
  9: (checkpoint, effects) => {
    const sessionState = readRecord(checkpoint, "sessionState");
    const snapshot = readRecord(sessionState, "snapshot");
    const { taskId: _taskId, ...session } = readRecord(snapshot, "session");
    return {
      ...checkpoint,
      serializedContext: upgradeLegacyCaller(
        omitKeys(readRecord(checkpoint, "serializedContext"), [
          "eve.activityObserver",
          "eve.activityPendingBlockers",
          "eve.activityRootTurnId",
          "eve.connectionSearchResults",
          "eve.internal.backgroundToolExecution",
          "eve.runtime.taskDeliveryPolicy",
          "eve.turnTaskDelivery",
        ]),
      ),
      sessionState: {
        ...sessionState,
        snapshot: {
          ...snapshot,
          session: {
            ...session,
            history: readArray(session, "history").map(renameBackgroundTaskMessage),
            state: upgradeSessionState(session.state, effects),
          },
        },
      },
    };
  },
  // History moved out of the durable session snapshot (eve 0.70).
  10: (checkpoint) => {
    const sessionState = readRecord(checkpoint, "sessionState");
    const snapshot = readRecord(sessionState, "snapshot");
    const { history, ...session } = readRecord(snapshot, "session");
    if (sessionState.version !== 1) refuse("durable session version is not 1");
    if (!Array.isArray(history)) refuse("session history is missing");
    return {
      ...checkpoint,
      history,
      sessionState: { ...sessionState, snapshot: { ...snapshot, session }, version: 2 },
    };
  },
  // Lifecycle moved from emission/batch registries to the projection and TurnState.
  11: upgradeIdleLifecycle,
  // Version 13 prevents older deployments from ignoring stubs and running real tools.
  // Existing checkpoints need no data changes.
  12: (checkpoint) => checkpoint,
};

/**
 * Upgrades a checkpoint written by an older eve build to the current shape.
 * Pure, so the session workflow can run it before validation. Newer
 * checkpoints and those older than {@link MIN_SESSION_CHECKPOINT_VERSION} are
 * incompatible.
 */
export function migrateSessionCheckpoint(checkpoint: unknown): SessionCheckpointMigration {
  if (!isObject(checkpoint)) return { kind: "incompatible", detail: "checkpoint is not an object" };
  const { version } = checkpoint;
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < MIN_SESSION_CHECKPOINT_VERSION ||
    version > SESSION_CHECKPOINT_VERSION
  ) {
    return {
      kind: "incompatible",
      detail: `checkpoint version ${JSON.stringify(version)} is outside the supported range ${MIN_SESSION_CHECKPOINT_VERSION}-${SESSION_CHECKPOINT_VERSION}`,
    };
  }
  const effects: UpgradeEffects = { childRunIdsToStop: [] };
  let current: CheckpointRecord = checkpoint;
  try {
    for (let from = version; from < SESSION_CHECKPOINT_VERSION; from++) {
      const upgrade = CHECKPOINT_UPGRADES[from];
      if (upgrade === undefined) refuse(`no upgrade from checkpoint version ${from}`);
      current = { ...upgrade(current, effects), version: from + 1 };
    }
  } catch (error) {
    if (!(error instanceof CheckpointRefusal)) throw error;
    return { kind: "incompatible", detail: `checkpoint version ${version}: ${error.message}` };
  }
  if (!isCurrentCheckpoint(current)) {
    return { kind: "incompatible", detail: `checkpoint version ${version} is incomplete` };
  }
  return { kind: "current", checkpoint: current, childRunIdsToStop: effects.childRunIdsToStop };
}

function upgradeIdleLifecycle(checkpoint: CheckpointRecord): CheckpointRecord {
  const sessionState = readRecord(checkpoint, "sessionState");
  if (sessionState.version !== 2) refuse("durable session version is not 2");
  const snapshot = readRecord(sessionState, "snapshot");
  const session = readRecord(snapshot, "session");
  const state = session.state === undefined ? {} : readRecord(session, "state");
  const emission = state["eve.harness.emission"] ?? sessionState.emissionState;
  if (
    !isObject(emission) ||
    typeof emission.sessionStarted !== "boolean" ||
    !Number.isSafeInteger(emission.sequence) ||
    (emission.sequence as number) < 0 ||
    !Number.isSafeInteger(emission.stepIndex) ||
    (emission.stepIndex as number) < 0 ||
    emission.turnId !== ""
  )
    refuse("lifecycle position is malformed or a turn is still open");

  const retiredPendingKeys = [
    HITL_STATE_KEYS.signIns,
    "eve.runtime.pendingInputBatch",
    "eve.runtime.pendingCoordinationBatch",
    "eve.runtime.deferredStepInput",
    "eve.harness.pendingWorkflowInterrupt",
  ];
  if (retiredPendingKeys.some((key) => state[key] !== undefined))
    refuse("session holds pending work");
  const batches = state["eve.runtime.pendingInputBatches"];
  if (batches !== undefined && (!Array.isArray(batches) || batches.length > 0))
    refuse("session holds pending input");
  const routes = state[HITL_STATE_KEYS.relays];
  if (
    sessionState.hasProxyInputRequests !== false ||
    (routes !== undefined && (!isObject(routes) || Object.keys(routes).length > 0))
  )
    refuse("session holds relayed input");
  try {
    if (getBlockingWorkflowToolRuns(state).length > 0) refuse("session holds workflow runs");
  } catch (error) {
    if (error instanceof CheckpointRefusal) throw error;
    refuse("workflow tool run registry is incompatible");
  }
  const approvals = state[HITL_STATE_KEYS.approvals];
  if (
    approvals !== undefined &&
    (!isObject(approvals) ||
      !isObject(approvals.activeCandidates) ||
      Object.keys(approvals.activeCandidates).length > 0)
  ) {
    refuse("session holds approval candidates or malformed approval state");
  }
  const grants = state["eve.runtime.hitl.approvedTools"] ?? [];
  if (!Array.isArray(grants) || !grants.every((grant) => typeof grant === "string"))
    refuse("approval grants are malformed");
  if (
    state["eve.harness.turnState"] !== undefined ||
    state["eve.harness.sessionProjection"] !== undefined
  )
    refuse("v11 checkpoint already contains machine state");
  const projection = { ...initialSessionProjection(), nextSequence: emission.sequence as number };
  if (emission.sessionStarted) projection.started = true;
  const nextState: CheckpointRecord = {
    ...omitKeys(state, [
      "eve.harness.emission",
      "eve.runtime.hitl.approvedTools",
      "eve.runtime.pendingInputBatches",
      HITL_STATE_KEYS.relays,
    ]),
    "eve.harness.sessionProjection": projection,
  };
  if (grants.length > 0)
    nextState["eve.harness.turnState"] = { grants: [...grants], suspended: [] };
  const { emissionState: _emission, ...durable } = sessionState;
  return {
    ...checkpoint,
    sessionState: {
      ...durable,
      snapshot: { ...snapshot, session: { ...session, state: nextState } },
    },
  };
}

function isCurrentCheckpoint(value: unknown): value is SessionCheckpoint {
  return (
    isObject(value) &&
    value.version === SESSION_CHECKPOINT_VERSION &&
    Array.isArray(value.history) &&
    isObject(value.serializedContext) &&
    isObject(value.sessionState)
  );
}

class CheckpointRefusal extends Error {}

function refuse(detail: string): never {
  throw new CheckpointRefusal(detail);
}

function readRecord(value: CheckpointRecord, key: string): CheckpointRecord {
  const field = value[key];
  if (!isObject(field)) refuse(`${key} is not an object`);
  return field;
}

function readArray(value: CheckpointRecord, key: string): unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) refuse(`${key} is not an array`);
  return field;
}

function omitKeys(record: CheckpointRecord, keys: readonly string[]): CheckpointRecord {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

/**
 * Earlier builds forwarded a session's questions to its caller as `task.*`
 * callbacks only when the callback named a task. The current build reads that
 * choice from the protocol-1 caller record instead.
 */
function upgradeLegacyCaller(context: CheckpointRecord): CheckpointRecord {
  const callback = context["eve.sessionCallback"];
  if (!isObject(callback)) return context;
  const { taskId, ...current } = callback;
  return {
    ...context,
    "eve.legacyRemoteAgentCaller":
      typeof taskId === "string" && taskId.length > 0 ? { taskId } : {},
    "eve.sessionCallback": current,
  };
}

// Task notifications are framework-authored task results; history validation rejects the old kind.
function renameBackgroundTaskMessage(message: unknown): unknown {
  return isObject(message) &&
    message.role === "user" &&
    message.kind === "execution.background_task"
    ? { ...message, kind: "task.result" }
    : message;
}

function upgradeSessionState(state: unknown, effects: UpgradeEffects): unknown {
  if (!isObject(state)) return state;
  return omitKeys(state, [
    ...dropSettledWorkflowToolRuns(state),
    ...stopIdleSubagents(state, effects),
  ]);
}

/**
 * Version 3 of the workflow tool run registry also recorded session-owned
 * background tasks. Settled ones already reported to the conversation and have
 * no current reader. Any other run means work is still in flight.
 */
function dropSettledWorkflowToolRuns(state: CheckpointRecord): string[] {
  const registry = state["eve.workflowTool"];
  if (!isObject(registry) || registry.version !== 3) return [];
  const runs = registry.runs;
  if (
    !Array.isArray(runs) ||
    !runs.every(
      (run) =>
        isObject(run) &&
        run.lifetime === "session" &&
        isObject(run.task) &&
        run.task.outcome !== undefined,
    )
  ) {
    refuse("workflow tool run registry version 3 holds unsettled runs");
  }
  return ["eve.workflowTool"];
}

/**
 * Earlier builds kept idle subagent sessions resumable through handles. The
 * current build has no reader for them, so the successor stops their local runs.
 * Remote sessions end on their own deployment.
 */
function stopIdleSubagents(state: CheckpointRecord, effects: UpgradeEffects): string[] {
  const store = state["eve.agent.handles"];
  if (store === undefined) return [];
  if (!isObject(store) || !Array.isArray(store.handles)) refuse("subagent handles are malformed");
  for (const handle of store.handles) {
    if (!isObject(handle) || (handle.phase !== "parked" && handle.phase !== "available")) {
      refuse("a subagent session is still working");
    }
    const address = handle.address;
    if (
      isObject(address) &&
      (address.kind === "agent/local" || address.kind === "agent/self") &&
      typeof address.sessionId === "string" &&
      address.sessionId.length > 0
    ) {
      effects.childRunIdsToStop.push(address.sessionId);
    }
  }
  return ["eve.agent.handles"];
}
