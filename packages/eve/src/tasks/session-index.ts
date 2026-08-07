import { z } from "#compiled/zod/index.js";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { JsonValue } from "#shared/json.js";
import { isTerminalTaskStatus, type TaskMetadata, type TaskView } from "#tasks/types.js";

/**
 * Session-state key for the parent's live-task index.
 *
 * The parent session stores only this index; the mutable task record
 * lives in the dedicated durable task run. The PR #1190 spike found the
 * session-state boundary unworkable for task state itself: session state
 * threads through step results, while callback routes and child
 * executors must update tasks without holding the current snapshot.
 */
export const SESSION_TASKS_STATE_KEY = "eve.tasks";

/**
 * One task owned by this session. Immutable model-safe metadata keeps the
 * task-to-agent join available before the task run publishes its first view.
 *
 * `commandToken` is the private routing credential for the task run's
 * command hook. It must never render into model context, history, task
 * snapshots, or compaction summaries — the model addresses tasks by
 * `taskId` only, and lookup verifies ownership through this index.
 */
export interface SessionTaskIndexEntry {
  readonly taskId: string;
  readonly taskRunId: string;
  /** Immutable fallback once the owning workflow run expires. */
  readonly terminalSnapshot?: TaskView;
  readonly commandToken: string;
  readonly createdByStepIndex?: number;
  readonly createdByTurnId: string;
  readonly metadata: TaskMetadata;
  readonly operationId: string;
}

const taskMetadataSchema: z.ZodType<TaskMetadata> = z.strictObject({
  agentId: z.string().min(1),
  kind: z.literal("subagent"),
  mode: z.enum(["local", "remote"]),
  name: z.string().min(1),
});

const taskViewSchema: z.ZodType<TaskView> = z
  .strictObject({
    executor: z
      .strictObject({
        childSessionId: z.string().min(1).optional(),
        childTurnId: z.string().min(1).optional(),
        lifecycle: z.enum(["parked", "terminal"]).optional(),
      })
      .optional(),
    inputRequests: z.array(z.custom<JsonValue>()).optional(),
    lastOutput: z
      .strictObject({ data: z.custom<JsonValue>(), type: z.enum(["result", "error"]) })
      .optional(),
    metadata: taskMetadataSchema,
    status: z.enum(["working", "input_required", "completed", "failed", "cancelled"]),
    taskId: z.string().min(1),
    usage: z
      .strictObject({
        cacheReadTokens: z.number().nonnegative(),
        cacheWriteTokens: z.number().nonnegative(),
        inputTokens: z.number().nonnegative(),
        outputTokens: z.number().nonnegative(),
      })
      .optional(),
  })
  .refine((view) => isTerminalTaskStatus(view.status), {
    message: "Cached task snapshots must be terminal.",
  });

const sessionTaskIndexEntrySchema: z.ZodType<SessionTaskIndexEntry> = z.strictObject({
  commandToken: z.string().min(1),
  createdByStepIndex: z.number().int().nonnegative().optional(),
  createdByTurnId: z.string().min(1),
  metadata: taskMetadataSchema,
  operationId: z.string().min(1),
  taskId: z.string().min(1),
  taskRunId: z.string().min(1),
  terminalSnapshot: taskViewSchema.optional(),
});

const sessionTaskIndexSchema = z
  .strictObject({
    tasks: z.array(sessionTaskIndexEntrySchema),
  })
  .refine(
    (index) => new Set(index.tasks.map((entry) => entry.taskId)).size === index.tasks.length,
    {
      message: "Task ids must be unique.",
    },
  );

interface SessionTaskIndex {
  readonly tasks: readonly SessionTaskIndexEntry[];
}

/**
 * Reads and validates the task index from session state.
 *
 * A present but invalid index throws: treating corruption as absence
 * would silently orphan every live task's routing credential.
 */
export function getSessionTaskIndex(
  state: SessionStateMap | undefined,
): readonly SessionTaskIndexEntry[] {
  const raw = state?.[SESSION_TASKS_STATE_KEY];
  if (raw === undefined) {
    return [];
  }
  const parsed = sessionTaskIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}": ${parsed.error.message}`,
    );
  }
  return parsed.data.tasks;
}

/** Caches one terminal snapshot beside its task-run address. */
export function cacheTerminalTaskSnapshot(
  state: SessionStateMap | undefined,
  snapshot: TaskView,
): SessionStateMap | undefined {
  if (!isTerminalTaskStatus(snapshot.status)) {
    throw new Error(`Cannot cache nonterminal task "${snapshot.taskId}".`);
  }
  const entries = getSessionTaskIndex(state);
  const index = entries.findIndex((entry) => entry.taskId === snapshot.taskId);
  if (index < 0) return state;
  const tasks = [...entries];
  tasks[index] = { ...tasks[index]!, terminalSnapshot: snapshot };
  return { ...state, [SESSION_TASKS_STATE_KEY]: { tasks } };
}

/** Finds one owned task; `undefined` enforces parent-session ownership. */
export function findSessionTaskEntry(
  state: SessionStateMap | undefined,
  taskId: string,
): SessionTaskIndexEntry | undefined {
  return getSessionTaskIndex(state).find((entry) => entry.taskId === taskId);
}

/**
 * Records one task, replacing any entry with the same id so replayed
 * creation for the same originating call stays idempotent.
 */
export function recordSessionTask(
  session: HarnessSession,
  entry: SessionTaskIndexEntry,
): HarnessSession {
  const existing = getSessionTaskIndex(session.state);
  const tasks = [...existing.filter((candidate) => candidate.taskId !== entry.taskId), entry];
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_TASKS_STATE_KEY]: { tasks } satisfies SessionTaskIndex,
    },
  };
}
