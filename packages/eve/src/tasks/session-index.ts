import { z } from "#compiled/zod/index.js";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskExecutorBinding } from "#tools/task.js";
import { sameTaskMetadata, type TaskMetadata, type TaskView } from "#tasks/types.js";

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
const SESSION_TASKS_STATE_VERSION = 2;

/**
 * One task owned by this session. Immutable model-safe metadata keeps the
 * task-to-agent join available before the task run publishes its first view.
 *
 * `taskInboxToken` is the private routing credential for the task run's
 * inbound hook. It must never render into model context, history, task
 * views, or compaction summaries — the model addresses tasks by
 * `taskId` only, and lookup verifies ownership through this index.
 */
export interface SessionTaskIndexEntry {
  readonly taskId: string;
  readonly taskRunId: string;
  /** Immutable fallback once the owning workflow run expires. */
  readonly terminalView?: TaskView;
  readonly taskInboxToken: string;
  readonly createdByStepIndex?: number;
  readonly createdByTurnId: string;
  readonly executor?: TaskExecutorBinding;
  readonly metadata: TaskMetadata;
}

const taskMetadataSchema = z.looseObject({
  kind: z.string().min(1),
  name: z.string().min(1),
}) as z.ZodType<TaskMetadata>;

const taskViewBaseShape = {
  executor: z
    .strictObject({
      binding: z
        .strictObject({
          data: z.record(z.string(), z.custom<JsonValue>()),
          kind: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
  metadata: taskMetadataSchema,
  state: z.record(z.string(), z.custom<JsonValue>()).optional(),
  taskId: z.string().min(1),
  usage: z
    .strictObject({
      cacheReadTokens: z.number().nonnegative(),
      cacheWriteTokens: z.number().nonnegative(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    })
    .optional(),
};

/**
 * Terminal views only, on purpose: the index caches a view solely as
 * the expired-run fallback, and the discriminated arms encode the terminal
 * status/output invariants structurally (strict objects reject
 * `inputRequests` and mismatched outputs).
 */
const taskViewSchema: z.ZodType<TaskView> = z.discriminatedUnion("status", [
  z.strictObject({
    ...taskViewBaseShape,
    lastOutput: z.strictObject({ data: z.custom<JsonValue>(), type: z.literal("result") }),
    status: z.literal("completed"),
  }),
  z.strictObject({
    ...taskViewBaseShape,
    lastOutput: z.strictObject({ data: z.custom<JsonValue>(), type: z.literal("error") }),
    status: z.literal("failed"),
  }),
  z.strictObject({ ...taskViewBaseShape, status: z.literal("cancelled") }),
]);

const sessionTaskIndexEntrySchema: z.ZodType<SessionTaskIndexEntry> = z.strictObject({
  taskInboxToken: z.string().min(1),
  createdByStepIndex: z.number().int().nonnegative().optional(),
  createdByTurnId: z.string().min(1),
  executor: z
    .strictObject({
      data: z.record(z.string(), z.custom<JsonValue>()),
      kind: z.string().min(1),
    })
    .optional(),
  metadata: taskMetadataSchema,
  taskId: z.string().min(1),
  taskRunId: z.string().min(1),
  terminalView: taskViewSchema.optional(),
});

const sessionTaskIndexSchema = z
  .strictObject({
    tasks: z.array(sessionTaskIndexEntrySchema),
    version: z.literal(SESSION_TASKS_STATE_VERSION),
  })
  .refine(
    (index) => new Set(index.tasks.map((entry) => entry.taskId)).size === index.tasks.length,
    {
      message: "Task ids must be unique.",
    },
  )
  .refine(
    (index) =>
      index.tasks.every(
        (entry) =>
          entry.terminalView === undefined ||
          (entry.terminalView.taskId === entry.taskId &&
            sameTaskMetadata(entry.terminalView.metadata, entry.metadata)),
      ),
    { message: "Cached terminal views must match their task index entry." },
  );

interface SessionTaskIndex {
  readonly tasks: readonly SessionTaskIndexEntry[];
  readonly version: typeof SESSION_TASKS_STATE_VERSION;
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
  const version = typeof raw === "object" && raw !== null ? Reflect.get(raw, "version") : undefined;
  if (version !== SESSION_TASKS_STATE_VERSION) {
    throw new Error(
      `Unsupported task index version ${JSON.stringify(version)} under session state key "${SESSION_TASKS_STATE_KEY}"; expected version ${SESSION_TASKS_STATE_VERSION}.`,
    );
  }
  const parsed = sessionTaskIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}": ${parsed.error.message}`,
    );
  }
  return parsed.data.tasks;
}

/** Caches one terminal view beside its task-run address. */
export function cacheTerminalTaskView(
  state: SessionStateMap | undefined,
  view: TaskView,
): SessionStateMap | undefined {
  if (!isValidTerminalView(view)) {
    throw new Error(`Cannot cache invalid terminal task "${view.taskId}".`);
  }
  const entries = getSessionTaskIndex(state);
  const index = entries.findIndex((entry) => entry.taskId === view.taskId);
  if (index < 0) return state;
  if (!sameTaskMetadata(entries[index]!.metadata, view.metadata)) {
    throw new Error(`Task view metadata does not match index entry "${view.taskId}".`);
  }
  const tasks = [...entries];
  tasks[index] = { ...tasks[index]!, terminalView: view };
  return {
    ...state,
    [SESSION_TASKS_STATE_KEY]: { tasks, version: SESSION_TASKS_STATE_VERSION },
  };
}

function isValidTerminalView(view: TaskView): boolean {
  if (view.inputRequests !== undefined) return false;
  switch (view.status) {
    case "completed":
      return view.lastOutput?.type === "result";
    case "failed":
      return view.lastOutput?.type === "error";
    case "cancelled":
      return view.lastOutput === undefined;
    // "input_required" is already excluded: its arm requires `inputRequests`.
    case "working":
      return false;
  }
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
      [SESSION_TASKS_STATE_KEY]: {
        tasks,
        version: SESSION_TASKS_STATE_VERSION,
      } satisfies SessionTaskIndex,
    },
  };
}
