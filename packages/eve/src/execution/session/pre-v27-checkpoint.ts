// Imports a handoff checkpoint from an owner before v27 (eve 0.66–0.83, checkpoint versions
// 8–17). Those owners keep running on their deployments, and each of their idle sessions moves to
// a v27 deployment at the next delivery that targets one. The upgrades through version 17 are the
// ones eve 0.83 shipped. The last step reads the v17 session in v27's shape, all but its session
// projection, which the successor folds from the session's stream (`pre-v27-successor.ts`).
//
// Delete once no pre-v27 deployment owns a session.

import { DURABLE_SESSION_VERSION } from "#execution/durable-session-read.js";
import { legacyUsage, normalizeHistory } from "#execution/session/imported-conversation.js";
import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import { isObject } from "#shared/guards.js";
import type { TokenUsage } from "#shared/token-usage.js";

/** The first checkpoint eve 0.66 wrote; older ones lack data any later reader requires. */
const OLDEST_PRE_V27_CHECKPOINT_VERSION = 8;
const LAST_PRE_V27_CHECKPOINT_VERSION = 17;

/** What the v26 session recorded outside its stream, for the projection the successor folds. */
export interface PreV27ProjectionSeed {
  /** Turns the v26 owner numbered: the next v27 turn takes the next number. */
  readonly turnCount: number;
  /** What the session spent, so its limits keep counting. */
  readonly usage?: TokenUsage;
  /** The latest accepted budget: the spend its window counts from, and how many came before. */
  readonly usageWindow?: { readonly index: number; readonly start: TokenUsage };
}

export interface PreV27Checkpoint<C = SessionCheckpoint> {
  /** The checkpoint in v27's shape, without its session projection. */
  readonly checkpoint: C;
  readonly seed: PreV27ProjectionSeed;
  /** Idle local subagent sessions only eve 0.66–0.68 tracked; the successor stops them. */
  readonly childRunIdsToStop: readonly string[];
}

export type PreV27CheckpointImport =
  /** Its checkpoint still unchecked against the current shape. */
  | { readonly kind: "pre-v27"; readonly imported: PreV27Checkpoint<Record<string, unknown>> }
  | { readonly kind: "incompatible"; readonly detail: string };

export function isPreV27CheckpointVersion(version: unknown): version is number {
  return (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= OLDEST_PRE_V27_CHECKPOINT_VERSION &&
    version <= LAST_PRE_V27_CHECKPOINT_VERSION
  );
}

/**
 * Reads a pre-v27 checkpoint in v27's shape. Pure, so the session workflow can run it before
 * validation. State v27 cannot continue, such as work still running on the old deployment,
 * refuses the import; the owner then keeps the session.
 */
export function importPreV27Checkpoint(
  checkpoint: Readonly<Record<string, unknown>> & { readonly version: number },
): PreV27CheckpointImport {
  const { version } = checkpoint;
  const effects: UpgradeEffects = { childRunIdsToStop: [] };
  try {
    let current: CheckpointRecord = checkpoint;
    for (let from = version; from < LAST_PRE_V27_CHECKPOINT_VERSION; from++) {
      const upgrade = CHECKPOINT_UPGRADES[from];
      if (upgrade === undefined) refuse(`no upgrade from checkpoint version ${from}`);
      current = { ...upgrade(current, effects), version: from + 1 };
    }
    return {
      kind: "pre-v27",
      imported: { ...importV17(current), childRunIdsToStop: effects.childRunIdsToStop },
    };
  } catch (error) {
    if (!(error instanceof CheckpointRefusal)) throw error;
    return { kind: "incompatible", detail: `checkpoint version ${version}: ${error.message}` };
  }
}

/** The imported checkpoint with the projection folded from its session's stream. */
export function withSeededProjection(
  checkpoint: SessionCheckpoint,
  projection: SessionProjection,
): SessionCheckpoint {
  const { sessionState } = checkpoint;
  const { session } = sessionState.snapshot;
  return {
    ...checkpoint,
    sessionState: {
      ...sessionState,
      snapshot: {
        ...sessionState.snapshot,
        session: {
          ...session,
          state: { ...session.state, [SESSION_PROJECTION_STATE_KEY]: projection },
        },
      },
    },
  };
}

type CheckpointRecord = Record<string, unknown>;

interface UpgradeEffects {
  readonly childRunIdsToStop: string[];
}

const LEGACY_HITL_STATE_KEYS = {
  approvals: "eve.runtime.hitl.approvalState",
  signIns: "eve.runtime.pendingAuthorization",
  relays: "eve.runtime.proxyInputRequests",
} as const;

const HITL_REQUESTS_KEY = "eve.runtime.hitl.requests";
const LEGACY_REMOTE_CALLER_KEY = "eve.legacyRemoteAgentCaller";

/** eve 0.83's upgrades, keyed by the version each reads. */
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
  12: (checkpoint) => checkpoint,
  13: (checkpoint) => checkpoint,
  // Approval candidates, sign-ins and relayed requests moved under one requests key.
  14: (checkpoint) => {
    const sessionState = readRecord(checkpoint, "sessionState");
    const snapshot = readRecord(sessionState, "snapshot");
    const session = readRecord(snapshot, "session");
    if (session.state === undefined) return checkpoint;
    const state = upgradeLegacyHitlState(readRecord(session, "state"));
    return {
      ...checkpoint,
      sessionState: { ...sessionState, snapshot: { ...snapshot, session: { ...session, state } } },
    };
  },
  // Older owners have never admitted keyed deliveries.
  15: (checkpoint) => ({ ...checkpoint, admittedDeliveryKeys: [] }),
  16: (checkpoint) => checkpoint,
};

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
    LEGACY_HITL_STATE_KEYS.signIns,
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
  const routes = state[LEGACY_HITL_STATE_KEYS.relays];
  if (
    sessionState.hasProxyInputRequests !== false ||
    (routes !== undefined && (!isObject(routes) || Object.keys(routes).length > 0))
  )
    refuse("session holds relayed input");
  const approvals = state[LEGACY_HITL_STATE_KEYS.approvals];
  if (approvals !== undefined && !hasNoActiveCandidates(approvals))
    refuse("session holds approval candidates or malformed approval state");
  const grants = state["eve.runtime.hitl.approvedTools"] ?? [];
  if (!Array.isArray(grants) || !grants.every((grant) => typeof grant === "string"))
    refuse("approval grants are malformed");
  if (
    state["eve.harness.turnState"] !== undefined ||
    state[SESSION_PROJECTION_STATE_KEY] !== undefined
  )
    refuse("v11 checkpoint already contains machine state");
  const nextState: CheckpointRecord = {
    ...omitKeys(state, [
      "eve.harness.emission",
      "eve.runtime.hitl.approvedTools",
      "eve.runtime.pendingInputBatches",
    ]),
    // The v26 projection; the v17 import reads only its turn numbering.
    [SESSION_PROJECTION_STATE_KEY]: { nextSequence: emission.sequence },
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

function upgradeLegacyHitlState(state: CheckpointRecord): CheckpointRecord {
  const {
    [LEGACY_HITL_STATE_KEYS.approvals]: approvals,
    [LEGACY_HITL_STATE_KEYS.signIns]: signIns,
    [LEGACY_HITL_STATE_KEYS.relays]: relays,
    ...rest
  } = state;
  const requests: CheckpointRecord = {};
  if (approvals !== undefined) requests.approvals = approvals;
  const challenges =
    isObject(signIns) && signIns.challenges !== undefined ? signIns.challenges : signIns;
  if (challenges !== undefined) requests.signIns = challenges;
  if (relays !== undefined && !(isObject(relays) && Object.keys(relays).length === 0))
    requests.relays = relays;
  return Object.keys(requests).length === 0 ? rest : { ...rest, [HITL_REQUESTS_KEY]: requests };
}

/**
 * Earlier builds forwarded a session's questions to its caller as `task.*`
 * callbacks only when the callback named a task. eve 0.69–0.83 read that
 * choice from the protocol-1 caller record instead.
 */
function upgradeLegacyCaller(context: CheckpointRecord): CheckpointRecord {
  const callback = context["eve.sessionCallback"];
  if (!isObject(callback)) return context;
  const { taskId, ...current } = callback;
  return {
    ...context,
    [LEGACY_REMOTE_CALLER_KEY]: typeof taskId === "string" && taskId.length > 0 ? { taskId } : {},
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
 * Earlier builds kept idle subagent sessions resumable through handles. Later
 * builds have no reader for them, so the successor stops their local runs.
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

// ---------------------------------------------------------------------------
// Version 17 → v27
// ---------------------------------------------------------------------------

/** State a v17 session keeps only while work runs, which no v27 build continues. */
const LIVE_WORK_STATE_KEYS: readonly string[] = [
  "eve.agent.handles",
  "eve.harness.emission",
  "eve.harness.pendingWorkflowInterrupt",
  "eve.runtime.deferredStepInput",
  "eve.runtime.hitl.approvedTools",
  "eve.runtime.pendingCoordinationBatch",
  "eve.runtime.pendingInputBatch",
  "eve.runtime.pendingInputBatches",
  "eve.runtime.workflowToolRuns",
  "eve.tasks",
  "eve.workflowTool",
  LEGACY_HITL_STATE_KEYS.approvals,
  LEGACY_HITL_STATE_KEYS.relays,
  LEGACY_HITL_STATE_KEYS.signIns,
];

/** Context v27 no longer defines: caches it recomputes and records only a running turn holds. */
const RETIRED_CONTEXT_KEYS: readonly string[] = [
  "eve.activeChannelDeliveries",
  "eve.approvedCallCallers",
  "eve.dynamicInstructionResolveMessages",
  "eve.dynamicSkillManifest",
  "eve.harness.instrumentationActionScopes",
  "eve.harness.instrumentationInputScopes",
  "eve.liveStepDynamicModelSelection",
  "eve.memory.pendingCommit",
  "eve.memory.preparedCompaction",
  "eve.memory.preparedPreamble",
  "eve.memory.turnLocks",
  "eve.nestedToolActions",
  "eve.pendingAnnouncements",
  "eve.pendingDynamicInstructionUserMessages",
  "eve.pendingSkillAnnouncement",
  "eve.pendingToolInterrupts",
  "eve.runtimeModelMetadataCache",
  "eve.schedulePreparedCreates",
  "eve.sessionDynamicInstructions",
  "eve.sessionDynamicModelReference",
  "eve.sessionDynamicSubagentRuntimeRevision",
  "eve.sessionDynamicSubagentSelections",
  "eve.sessionDynamicToolMetadata",
  "eve.sessionDynamicToolRuntimeRevision",
  "eve.stepDynamicToolMetadata",
  "eve.turnDynamicInstructions",
  "eve.turnDynamicModelReference",
  "eve.turnDynamicSubagentSelections",
  "eve.turnDynamicToolMetadata",
];
const RETIRED_CONTEXT_PREFIX = "eve.experimental.decide.model.";

const EARLIER_REMOTE_CALLER_KEY = "eve.earlierRemoteCaller";
const DYNAMIC_SKILL_SANDBOX_KEY = "eve.dynamicSkillSandbox";
const MEMORY_KEY = "eve.memory";

function importV17(
  checkpoint: CheckpointRecord,
): Omit<PreV27Checkpoint<CheckpointRecord>, "childRunIdsToStop"> {
  const sessionState = readRecord(checkpoint, "sessionState");
  if (sessionState.version !== DURABLE_SESSION_VERSION) refuse("durable session version is not 2");
  const snapshot = readRecord(sessionState, "snapshot");
  const session = readRecord(snapshot, "session");
  const imported = importSessionState(
    session.state === undefined ? {} : readRecord(session, "state"),
  );
  const compaction =
    imported.requestEnvelopeTokens === undefined
      ? session.compaction
      : {
          ...(isObject(session.compaction) ? session.compaction : {}),
          requestEnvelopeTokens: imported.requestEnvelopeTokens,
        };
  const serializedContext = importContext(readRecord(checkpoint, "serializedContext"));
  const callerSpeaksEarlierProtocol = serializedContext[EARLIER_REMOTE_CALLER_KEY] !== undefined;
  return {
    checkpoint: {
      ...checkpoint,
      // A v27 session relays no requests to a caller on an earlier protocol.
      ...(callerSpeaksEarlierProtocol && { capabilities: { requestInput: false } }),
      history: importHistory(readArray(checkpoint, "history")),
      serializedContext,
      sessionState: {
        ...sessionState,
        snapshot: {
          ...snapshot,
          session: {
            ...session,
            ...(compaction !== undefined && { compaction }),
            state: imported.state,
          },
        },
      },
      version: SESSION_CHECKPOINT_VERSION,
    },
    seed: imported.seed,
  };
}

function importSessionState(state: CheckpointRecord): {
  readonly requestEnvelopeTokens: number | undefined;
  readonly seed: PreV27ProjectionSeed;
  readonly state: CheckpointRecord;
} {
  const next: CheckpointRecord = {};
  let turnCount: number | undefined;
  let usage: TokenUsage | undefined;
  let requestEnvelopeTokens: number | undefined;
  for (const [key, value] of Object.entries(state)) {
    if (LIVE_WORK_STATE_KEYS.includes(key)) refuse(`session state holds ${key}`);
    switch (key) {
      case SESSION_PROJECTION_STATE_KEY:
        turnCount = readV26TurnCount(value);
        break;
      case "eve.harness.turnState":
        requireSettledTurnState(value);
        break;
      case HITL_REQUESTS_KEY:
        requireSettledHitlRequests(value);
        break;
      case "eve.taskTable":
        requireFinishedTasks(value);
        break;
      case "eve.harness.turnUsage":
        usage = isObject(value) ? legacyUsage(value.session) : undefined;
        break;
      case "eve.harness.reportedSessionUsage": {
        const reported = legacyUsage(value);
        if (reported !== undefined) next[key] = reported;
        break;
      }
      case "eve.harness.requestEnvelopeTokens":
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          requestEnvelopeTokens = value;
        break;
      // The usage window is read below; v27 recalls memory on every call.
      case "eve.harness.sessionUsageWindowIndex":
      case "eve.harness.sessionUsageWindowStart":
      case MEMORY_KEY:
        break;
      default:
        next[key] = value;
    }
  }
  if (turnCount === undefined) refuse("session projection is missing");
  const index = state["eve.harness.sessionUsageWindowIndex"];
  const start = legacyUsage(state["eve.harness.sessionUsageWindowStart"]);
  const usageWindow =
    typeof index === "number" && Number.isSafeInteger(index) && index > 0 && start !== undefined
      ? { index, start }
      : undefined;
  return {
    requestEnvelopeTokens,
    seed: {
      turnCount,
      ...(usage !== undefined && { usage }),
      ...(usageWindow !== undefined && { usageWindow }),
    },
    state: next,
  };
}

function readV26TurnCount(projection: unknown): number {
  if (!isObject(projection)) refuse("session projection is malformed");
  if (projection.activeTurnId !== undefined) refuse("a turn is still open");
  const { nextSequence } = projection;
  if (typeof nextSequence !== "number" || !Number.isSafeInteger(nextSequence) || nextSequence < 0)
    refuse("session projection is malformed");
  return nextSequence;
}

/**
 * v27 remembers approvals per policy rather than by v26's grant keys, so the session asks again
 * the first time it needs one.
 */
function requireSettledTurnState(turn: unknown): void {
  if (!isObject(turn)) refuse("turn state is malformed");
  if (turn.queued !== undefined) refuse("session holds queued turn input");
  if (turn.suspended !== undefined && (!Array.isArray(turn.suspended) || turn.suspended.length > 0))
    refuse("session holds a suspended step");
}

/** Only the approval audit trail may remain; v27 keeps none. */
function requireSettledHitlRequests(requests: unknown): void {
  if (!isObject(requests)) refuse("human-in-the-loop requests are malformed");
  if (requests.signIns !== undefined) refuse("session holds a sign-in");
  const { relays } = requests;
  if (relays !== undefined && (!isObject(relays) || Object.keys(relays).length > 0))
    refuse("session holds relayed input");
  if (requests.approvals !== undefined && !hasNoActiveCandidates(requests.approvals))
    refuse("session holds approval candidates or malformed approval state");
}

/** Finished records only answer `already_finished`; a live task runs on the old deployment. */
function requireFinishedTasks(table: unknown): void {
  if (!isObject(table) || !Array.isArray(table.tasks)) refuse("task table is malformed");
  for (const task of table.tasks) {
    if (
      !isObject(task) ||
      task.run !== undefined ||
      (Array.isArray(task.held) && task.held.length > 0) ||
      !Array.isArray(task.calls) ||
      task.calls.length > 0 ||
      !Array.isArray(task.results) ||
      task.results.length > 0
    )
      refuse("session holds a running task");
  }
}

function hasNoActiveCandidates(approvals: unknown): boolean {
  return (
    isObject(approvals) &&
    isObject(approvals.activeCandidates) &&
    Object.keys(approvals.activeCandidates).length === 0
  );
}

function importContext(context: CheckpointRecord): CheckpointRecord {
  const next: CheckpointRecord = {};
  for (const [key, value] of Object.entries(context)) {
    if (RETIRED_CONTEXT_KEYS.includes(key) || key.startsWith(RETIRED_CONTEXT_PREFIX)) continue;
    if (key === LEGACY_REMOTE_CALLER_KEY) continue;
    // v27 marks files with the skill revision written: an unmarked entry rewrites a live skill's
    // files and still finds a withdrawn skill's files to remove.
    if (key === DYNAMIC_SKILL_SANDBOX_KEY && isObject(value)) {
      next[key] = Object.fromEntries(
        Object.entries(value).map(([name, identity]) => [
          name,
          typeof identity === "string" ? `${identity}#` : identity,
        ]),
      );
      continue;
    }
    next[key] = value;
  }
  // The caller spoke protocol 1 (eve 0.66–0.68) or 2 (eve 0.69–0.83).
  if (isObject(context["eve.sessionCallback"]))
    next[EARLIER_REMOTE_CALLER_KEY] = context[LEGACY_REMOTE_CALLER_KEY] === undefined ? 2 : 1;
  return next;
}

/**
 * eve 0.83 kept memory recalls in history and filtered them as it read; v27 recalls on every call,
 * and its compaction expects the checkpoint marker first.
 */
function importHistory(history: unknown[]) {
  const kept = history.filter(
    (message) =>
      !(
        isObject(message) &&
        message.role === "user" &&
        isObject(message.metadata) &&
        message.metadata[MEMORY_KEY] !== undefined
      ),
  );
  try {
    return normalizeHistory(kept as Parameters<typeof normalizeHistory>[0]);
  } catch (error) {
    refuse(`session history is malformed: ${error instanceof Error ? error.message : "unknown"}`);
  }
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
