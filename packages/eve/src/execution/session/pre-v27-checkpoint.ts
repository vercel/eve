import {
  EARLIER_REMOTE_CALLER_CONTEXT_KEY_NAME,
  SESSION_CALLBACK_CONTEXT_KEY_NAME,
} from "#context/key-names.js";
import { DURABLE_SESSION_VERSION } from "#execution/durable-session-read.js";
import { CheckpointRefusal, refuse } from "#execution/session/checkpoint-refusal.js";
import { normalizeHistory } from "#execution/session/imported-conversation.js";
import {
  SESSION_CHECKPOINT_VERSION,
  type SessionCheckpoint,
} from "#execution/session/checkpoint.js";
import type { TaskRunAddress } from "#execution/tasks/table.js";
import { SESSION_PROJECTION_STATE_KEY } from "#harness/session-machine/view.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";
import { isObject } from "#shared/guards.js";

export interface PreV27Checkpoint<C = SessionCheckpoint> {
  readonly checkpoint: C;
  readonly turnCount: number;
  readonly retiredRuns?: readonly TaskRunAddress[];
}

export type PreV27CheckpointImport =
  | { readonly kind: "pre-v27"; readonly imported: PreV27Checkpoint<Record<string, unknown>> }
  | { readonly kind: "busy"; readonly detail: string }
  | { readonly kind: "incompatible"; readonly detail: string };

export function isPreV27CheckpointVersion(version: unknown): version is number {
  return (
    typeof version === "number" && Number.isSafeInteger(version) && version >= 10 && version <= 17
  );
}

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
  const retiredRuns = retireIdleTasks(state["eve.taskTable"]);
  const history = Array.isArray(checkpoint.history) ? checkpoint.history : session.history;
  if (!Array.isArray(history)) refuse("session history is missing");
  const context = readRecord(checkpoint, "serializedContext");
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
    ...(retiredRuns.length > 0 && { retiredRuns }),
  };
}

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

function retireIdleTasks(table: unknown): TaskRunAddress[] {
  if (table === undefined) return [];
  if (!isObject(table) || !Array.isArray(table.tasks)) refuse("task table is malformed");
  const tasks: readonly unknown[] = table.tasks;
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
