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
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import { isObject } from "#shared/guards.js";

export interface PreV27Checkpoint<C = SessionCheckpoint> {
  /** The checkpoint in v27's shape, without its session projection. */
  readonly checkpoint: C;
  /** Turns the earlier owner numbered: the next turn takes the next number. */
  readonly turnCount: number;
}

export type PreV27CheckpointImport =
  /** Its checkpoint still unchecked against the current shape. */
  | { readonly kind: "pre-v27"; readonly imported: PreV27Checkpoint<Record<string, unknown>> }
  | { readonly kind: "incompatible"; readonly detail: string };

export function isPreV27CheckpointVersion(version: unknown): version is number {
  // eve 0.68 and earlier saved contexts in a layout that holds keys this build no longer defines.
  return (
    typeof version === "number" && Number.isSafeInteger(version) && version >= 10 && version <= 17
  );
}

/**
 * Reads a pre-v27 checkpoint in v27's shape. Pure, so the session workflow can run it before
 * validation. The earlier owner only hands off an idle session; a task it still tracks keeps the
 * session on that owner.
 */
export function importPreV27Checkpoint(
  checkpoint: Readonly<Record<string, unknown>>,
): PreV27CheckpointImport {
  try {
    return { kind: "pre-v27", imported: importCheckpoint(checkpoint) };
  } catch (error) {
    if (!(error instanceof CheckpointRefusal)) throw error;
    return {
      kind: "incompatible",
      detail: `checkpoint version ${String(checkpoint.version)}: ${error.message}`,
    };
  }
}

/**
 * The projection of a session whose earlier lines a v27 writer never folded: it writes after
 * `tailIndex`, and its next turn follows the earlier owner's last. An empty stream has not opened.
 */
export function preV27Projection(tailIndex: number, turnCount: number): SessionProjection {
  const projection = initialSessionProjection();
  return {
    ...projection,
    view: {
      ...projection.view,
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

function importCheckpoint(checkpoint: CheckpointRecord): PreV27Checkpoint<CheckpointRecord> {
  const sessionState = readRecord(checkpoint, "sessionState");
  const session = readRecord(readRecord(sessionState, "snapshot"), "session");
  if (typeof sessionState.sessionId !== "string") refuse("session id is missing");
  const state = session.state === undefined ? {} : readRecord(session, "state");
  const turnCount = readTurnCount(sessionState, state);
  requireFinishedTasks(state["eve.taskTable"]);
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
            // Authored and extension state; the earlier build's framework records stay behind.
            state: Object.fromEntries(
              Object.entries(state).filter(([key]) => !key.startsWith("eve.")),
            ),
          },
        },
        version: DURABLE_SESSION_VERSION,
      },
      sessionTimeoutMs: checkpoint.sessionTimeoutMs,
      version: SESSION_CHECKPOINT_VERSION,
    },
    turnCount,
  };
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

/** Earlier owners hand off with tasks still running; their runs answer only the old owner. */
function requireFinishedTasks(table: unknown): void {
  if (table === undefined) return;
  if (!isObject(table) || !Array.isArray(table.tasks)) refuse("task table is malformed");
  for (const task of table.tasks) {
    if (
      !isObject(task) ||
      task.run !== undefined ||
      (Array.isArray(task.held) && task.held.length > 0) ||
      (Array.isArray(task.calls) && task.calls.length > 0)
    )
      refuse("session holds a running task");
  }
}

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
