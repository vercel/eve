// Imports a handoff checkpoint from an owner before v27 (eve 0.69–0.83, checkpoint versions 10–17)
// the way an incompatible upgrade starts over: the successor keeps the session's identity, authored
// state, and conversation, which it compacts before anything else, and leaves the earlier build's
// framework records behind. It continues the session's stream after the lines already on it.
//
// Delete once no pre-v27 deployment owns a session.

import {
  EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME,
  SESSION_CALLBACK_CONTEXT_KEY_NAME,
} from "#context/key-names.js";
import { DURABLE_SESSION_VERSION } from "#execution/durable-session-read.js";
import { CheckpointRefusal, refuse } from "#execution/session/checkpoint-refusal.js";
import { normalizeHistory } from "#execution/session/imported-conversation.js";
import { SESSION_CHECKPOINT_VERSION, type SessionCheckpoint } from "#execution/session/handoff.js";
import type { TaskRunAddress } from "#execution/tasks/table.js";
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import { usageOf } from "#harness/facts.js";
import { withModelUsage } from "#harness/session-usage.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import { isObject } from "#shared/guards.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface PreV27Checkpoint<C = SessionCheckpoint> {
  /** The checkpoint in v27's shape, without its session projection. */
  readonly checkpoint: C;
  /** Turns the earlier owner numbered: the next turn takes the next number. */
  readonly turnCount: number;
  /** What the earlier owner counted the session spent, so its usage limit keeps counting. */
  readonly usage?: PreV27Usage;
  /**
   * Runs of idle resumable tasks the import leaves behind. The successor sends each an end
   * control once it holds the session; the model starts a new task on this build when it needs one.
   */
  readonly retiredRuns?: readonly TaskRunAddress[];
}

export interface PreV27Usage {
  readonly total: TokenUsage;
  /** The window the latest approved continuation started, as `limits.sessionUsage` sees it. */
  readonly window?: { readonly index: number; readonly start: TokenUsage };
}

export type PreV27CheckpointImport =
  /** Its checkpoint still unchecked against the current shape. */
  | { readonly kind: "pre-v27"; readonly imported: PreV27Checkpoint<Record<string, unknown>> }
  /** Work the earlier owner runs will finish; a later delivery can move the session. */
  | { readonly kind: "busy"; readonly detail: string }
  | { readonly kind: "incompatible"; readonly detail: string };

export function isPreV27CheckpointVersion(version: unknown): version is number {
  // eve 0.68 and earlier saved contexts in a layout that holds keys this build no longer defines.
  return (
    typeof version === "number" && Number.isSafeInteger(version) && version >= 10 && version <= 17
  );
}

/**
 * Reads a pre-v27 checkpoint in v27's shape. Pure, so the session workflow can run it before
 * validation. The earlier owner only hands off an idle session. An idle resumable task doesn't
 * keep it there; a task still working, or with results the model hasn't read, does.
 */
export function importPreV27Checkpoint(
  checkpoint: Readonly<Record<string, unknown>>,
): PreV27CheckpointImport {
  try {
    return { kind: "pre-v27", imported: importCheckpoint(checkpoint) };
  } catch (error) {
    if (!(error instanceof CheckpointRefusal) && !(error instanceof SessionBusy)) throw error;
    return {
      kind: error instanceof SessionBusy ? "busy" : "incompatible",
      detail: `checkpoint version ${String(checkpoint.version)}: ${error.message}`,
    };
  }
}

/**
 * The projection of a session whose earlier lines a v27 writer never folded: it writes after
 * `tailIndex`, and its next turn follows the earlier owner's last. An empty stream has not opened.
 */
export function preV27Projection(
  tailIndex: number,
  turnCount: number,
  usage?: PreV27Usage,
): SessionProjection {
  const projection = initialSessionProjection();
  const view = usage === undefined ? projection.view : withModelUsage(projection.view, usage.total);
  return {
    ...projection,
    // The earlier owner records no budget prompt this build reads: the window keeps only its start.
    ...(usage?.window !== undefined && {
      usageWindow: { ...usage.window, interactionId: "pre-v27" },
    }),
    view: {
      ...view,
      position: tailIndex + 1,
      session: {
        status: tailIndex < 0 ? "new" : "open",
        turnCount,
        ...(turnCount > 0 && { latestTurnId: `turn_${String(turnCount - 1)}` }),
      },
    },
  };
}

/** The imported checkpoint with its session projection. */
export function withProjection(
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

const LEGACY_REMOTE_CALLER_KEY = "eve.legacyRemoteAgentCaller";
const TURN_USAGE_KEY = "eve.harness.turnUsage";
const REPORTED_USAGE_KEY = "eve.harness.reportedSessionUsage";
const USAGE_WINDOW_START_KEY = "eve.harness.sessionUsageWindowStart";
const USAGE_WINDOW_INDEX_KEY = "eve.harness.sessionUsageWindowIndex";

function importCheckpoint(checkpoint: CheckpointRecord): PreV27Checkpoint<CheckpointRecord> {
  const sessionState = readRecord(checkpoint, "sessionState");
  const session = readRecord(readRecord(sessionState, "snapshot"), "session");
  if (typeof sessionState.sessionId !== "string") refuse("session id is missing");
  const state = session.state === undefined ? {} : readRecord(session, "state");
  const turnCount = readTurnCount(sessionState, state);
  const retiredRuns = retireIdleTasks(state["eve.taskTable"]);
  const usage = importUsage(state);
  const reported = legacyUsage(state[REPORTED_USAGE_KEY]);
  // eve 0.69 kept history in the durable snapshot.
  const history = Array.isArray(checkpoint.history) ? checkpoint.history : session.history;
  if (!Array.isArray(history)) refuse("session history is missing");
  const context = readRecord(checkpoint, "serializedContext");
  // A caller from before v27 gets its result but no relayed requests, which it can't read.
  const callback = context[SESSION_CALLBACK_CONTEXT_KEY_NAME];
  const earlierCaller = isObject(callback)
    ? context[LEGACY_REMOTE_CALLER_KEY] === undefined
      ? 2
      : 1
    : undefined;
  return {
    checkpoint: {
      admittedDeliveryKeys: Array.isArray(checkpoint.admittedDeliveryKeys)
        ? checkpoint.admittedDeliveryKeys
        : [],
      ...(earlierCaller === undefined
        ? checkpoint.capabilities !== undefined && { capabilities: checkpoint.capabilities }
        : { capabilities: { requestInput: false } }),
      history: importHistory(history),
      ...(checkpoint.retention !== undefined && { retention: checkpoint.retention }),
      // This build's context reader drops the keys it no longer defines.
      serializedContext:
        earlierCaller === undefined
          ? context
          : {
              ...context,
              "eve.capabilities": { requestInput: false },
              [EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME]: earlierCaller,
            },
      sessionState: {
        continuationToken: sessionState.continuationToken,
        hasProxyInputRequests: false,
        sessionId: sessionState.sessionId,
        snapshot: {
          session: {
            agent: isObject(session.agent) ? session.agent : { system: "" },
            continuationToken: session.continuationToken,
            sessionId: session.sessionId,
            ...pick(session, ["outputSchema", "rootSessionId", "sandboxState"]),
            // Authored and extension state; the earlier build's framework records stay behind,
            // but for the spend a parent was already told.
            state: {
              ...Object.fromEntries(
                Object.entries(state).filter(([key]) => !key.startsWith("eve.")),
              ),
              ...(reported !== undefined && { [REPORTED_USAGE_KEY]: reported }),
            },
          },
        },
        version: DURABLE_SESSION_VERSION,
      },
      sessionTimeoutMs: checkpoint.sessionTimeoutMs,
      version: SESSION_CHECKPOINT_VERSION,
    },
    turnCount,
    ...(usage !== undefined && { usage }),
    ...(retiredRuns.length > 0 && { retiredRuns }),
  };
}

/** The session total and approved window the earlier owner counted, as the legacy import reads them. */
function importUsage(state: CheckpointRecord): PreV27Usage | undefined {
  const turnUsage = state[TURN_USAGE_KEY];
  const total = legacyUsage(isObject(turnUsage) ? turnUsage.session : undefined);
  if (total === undefined) return undefined;
  const index = state[USAGE_WINDOW_INDEX_KEY];
  const start = legacyUsage(state[USAGE_WINDOW_START_KEY]);
  return typeof index === "number" &&
    Number.isSafeInteger(index) &&
    index > 0 &&
    start !== undefined
    ? { total, window: { index, start } }
    : { total };
}

/** Turns the earlier owner numbered, from its projection (eve 0.70+) or its emission state. */
function readTurnCount(sessionState: CheckpointRecord, state: CheckpointRecord): number {
  const projection = state[SESSION_PROJECTION_STATE_KEY];
  if (isObject(projection)) {
    if (projection.activeTurnId !== undefined) refuse("a turn is still open");
    return readCount(projection.nextSequence);
  }
  const emission = state["eve.harness.emission"] ?? sessionState.emissionState;
  if (!isObject(emission)) refuse("the session's turn position is missing");
  if (emission.turnId !== "") refuse("a turn is still open");
  return readCount(emission.sequence);
}

function readCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    refuse("the session's turn position is malformed");
  return value;
}

/**
 * The runs of the earlier owner's idle resumable tasks, which this build leaves behind: on an
 * earlier owner such a task keeps its run for the life of the session, so it never finishes.
 * Results the model hasn't read, a task still working, or one whose run can't take an end control
 * yet keep the session on its owner until that clears.
 */
function retireIdleTasks(table: unknown): TaskRunAddress[] {
  if (table === undefined) return [];
  if (!isObject(table) || !Array.isArray(table.tasks)) refuse("task table is malformed");
  const tasks: readonly unknown[] = table.tasks;
  // A finished task keeps its results, without a run, until the owner's next model step.
  if (
    tasks.some((task) => isObject(task) && Array.isArray(task.results) && task.results.length > 0)
  )
    throw new SessionBusy("session holds task results the model hasn't read");
  return tasks.flatMap((task) => {
    if (isObject(task) && task.run === undefined && !isWorking(task)) return [];
    const run = isObject(task) ? task.run : undefined;
    if (
      !isObject(task) ||
      isWorking(task) ||
      task.resumable !== true ||
      task.cancelled === true ||
      !isObject(run) ||
      run.started !== true ||
      typeof run.hookToken !== "string" ||
      typeof run.runId !== "string"
    )
      throw new SessionBusy("session holds a running task");
    return [{ hookToken: run.hookToken, runId: run.runId }];
  });
}

/** A usage total an earlier owner kept: its counts, and its cost only when a provider reported one. */
function legacyUsage(raw: unknown): TokenUsage | undefined {
  if (!isObject(raw)) return undefined;
  const count = (field: string) => (typeof raw[field] === "number" ? raw[field] : 0);
  return usageOf({
    cacheReadTokens: count("cacheReadTokens"),
    cacheWriteTokens: count("cacheWriteTokens"),
    costUsd: raw.sawCost === true && typeof raw.costUsd === "number" ? raw.costUsd : undefined,
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
  });
}

function isWorking(task: CheckpointRecord): boolean {
  return (
    (Array.isArray(task.held) && task.held.length > 0) ||
    (Array.isArray(task.calls) && task.calls.length > 0)
  );
}

class SessionBusy extends Error {}

function importHistory(history: unknown[]) {
  try {
    return normalizeHistory(history as Parameters<typeof normalizeHistory>[0]);
  } catch (error) {
    refuse(`session history is malformed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

function pick(record: CheckpointRecord, keys: readonly string[]): CheckpointRecord {
  return Object.fromEntries(
    keys.flatMap((key) => (record[key] === undefined ? [] : [[key, record[key]]])),
  );
}

function readRecord(value: CheckpointRecord, key: string): CheckpointRecord {
  const field = value[key];
  if (!isObject(field)) refuse(`${key} is not an object`);
  return field;
}
