import { z } from "#compiled/zod/index.js";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { parseActivityWorkIdentityV1, type ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { JsonValue } from "#shared/json.js";
import type { TaskExecutorBinding } from "#tools/task.js";
import { sameTaskMetadata, type TaskMetadata, type TaskView } from "#tasks/types.js";
import {
  getTaskCohortId,
  SESSION_TASKS_STATE_KEY,
  SESSION_TASKS_STATE_VERSION,
} from "#tasks/session-task-cohorts.js";

/**
 * Session-state key for the parent's live-task index.
 *
 * The parent session stores only this index; the mutable task record
 * lives in the dedicated durable task run. The PR #1190 spike found the
 * session-state boundary unworkable for task state itself: session state
 * threads through step results, while callback routes and child
 * executors must update tasks without holding the current snapshot.
 */
export { SESSION_TASKS_STATE_KEY } from "#tasks/session-task-cohorts.js";

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
  readonly activityWorkIdentity?: ActivityWorkIdentityV1;
  readonly taskId: string;
  readonly taskRunId: string;
  /** Immutable fallback once the owning workflow run expires. */
  readonly terminalView?: TaskView;
  readonly taskInboxToken: string;
  readonly createdByStepIndex?: number;
  readonly createdByTurnId: string;
  /** Immutable join target; absent on the task that starts a cohort. */
  readonly cohortId?: string;
  readonly executor?: TaskExecutorBinding;
  readonly metadata: TaskMetadata;
}

const taskMetadataSchema = z.looseObject({
  kind: z.string().min(1),
  name: z.string().min(1),
}) as z.ZodType<TaskMetadata>;

const taskViewBaseShape = {
  // Terminal views never carry pending requests; the loose object must say so explicitly.
  inputRequests: z.never().optional(),
  executor: z
    .looseObject({
      binding: z
        .looseObject({
          data: z.record(z.string(), z.custom<JsonValue>()),
          kind: z.string().min(1),
        })
        .optional(),
    })
    .optional(),
  metadata: taskMetadataSchema,
  taskId: z.string().min(1),
  usage: z
    .looseObject({
      cacheReadTokens: z.number().nonnegative(),
      cacheWriteTokens: z.number().nonnegative(),
      costUsd: z.number().finite().nonnegative().optional(),
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    })
    .optional(),
};

/**
 * Terminal views only, on purpose: the index caches a view solely as
 * the expired-run fallback, and the discriminated arms encode the terminal
 * status/output invariants structurally (explicit fields reject
 * `inputRequests` and mismatched outputs while preserving additive metadata).
 */
const taskViewSchema: z.ZodType<TaskView> = z.discriminatedUnion("status", [
  z.looseObject({
    ...taskViewBaseShape,
    lastOutput: z.looseObject({ data: z.custom<JsonValue>(), type: z.literal("result") }),
    status: z.literal("completed"),
  }),
  z.looseObject({
    ...taskViewBaseShape,
    lastOutput: z.looseObject({ data: z.custom<JsonValue>(), type: z.literal("error") }),
    status: z.literal("failed"),
  }),
  z.looseObject({
    ...taskViewBaseShape,
    lastOutput: z.never().optional(),
    status: z.literal("cancelled"),
  }),
]);

const sessionTaskIndexEntrySchema: z.ZodType<SessionTaskIndexEntry> = z.looseObject({
  activityWorkIdentity: z
    .custom<ActivityWorkIdentityV1>((value) => parseActivityWorkIdentityV1(value) !== undefined)
    .optional(),
  taskInboxToken: z.string().min(1),
  createdByStepIndex: z.number().int().nonnegative().optional(),
  createdByTurnId: z.string().min(1),
  cohortId: z.string().min(1).optional(),
  executor: z
    .looseObject({
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
  .looseObject({
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
  readonly [key: string]: unknown;
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
  return readSessionTaskIndex(state).tasks;
}

function readSessionTaskIndex(state: SessionStateMap | undefined): SessionTaskIndex {
  const raw = state?.[SESSION_TASKS_STATE_KEY];
  if (raw === undefined) {
    return { tasks: [], version: SESSION_TASKS_STATE_VERSION };
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
  return parsed.data;
}

/** Caches one terminal view beside its task-run address. */
export function cacheTerminalTaskView(
  state: SessionStateMap | undefined,
  view: TaskView,
): SessionStateMap | undefined {
  if (!isValidTerminalView(view)) {
    throw new Error(`Cannot cache invalid terminal task "${view.taskId}".`);
  }
  const stored = readSessionTaskIndex(state);
  const entries = stored.tasks;
  const index = entries.findIndex((entry) => entry.taskId === view.taskId);
  if (index < 0) return state;
  if (!sameTaskMetadata(entries[index]!.metadata, view.metadata)) {
    throw new Error(`Task view metadata does not match index entry "${view.taskId}".`);
  }
  const tasks = [...entries];
  const previous = tasks[index]!.terminalView;
  tasks[index] = {
    ...tasks[index]!,
    terminalView: taskViewSchema.parse({
      ...previous,
      ...view,
      metadata: { ...previous?.metadata, ...view.metadata },
      lastOutput:
        view.lastOutput === undefined
          ? undefined
          : {
              ...previous?.lastOutput,
              ...view.lastOutput,
            },
      usage: view.usage === undefined ? undefined : { ...previous?.usage, ...view.usage },
      executor:
        view.executor === undefined
          ? undefined
          : {
              ...previous?.executor,
              ...view.executor,
              binding:
                view.executor.binding === undefined
                  ? undefined
                  : {
                      ...previous?.executor?.binding,
                      ...view.executor.binding,
                    },
            },
    }),
  };
  return {
    ...state,
    [SESSION_TASKS_STATE_KEY]: { ...stored, tasks },
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
 * Joins the indexed cohort that still has unreported/nonterminal work. Cached
 * terminal siblings remain members until the whole cohort settles. Membership
 * and creation provenance survive replay, even after that cohort has settled.
 */
export function recordSessionTask(
  session: HarnessSession,
  entry: Omit<SessionTaskIndexEntry, "cohortId">,
): HarnessSession {
  const stored = readSessionTaskIndex(session.state);
  const tasks = [...stored.tasks];
  const index = tasks.findIndex((candidate) => candidate.taskId === entry.taskId);
  const previous = tasks[index];
  if (previous !== undefined) {
    tasks[index] = {
      ...previous,
      ...entry,
      metadata: { ...previous.metadata, ...entry.metadata },
      activityWorkIdentity:
        entry.activityWorkIdentity === undefined
          ? previous.activityWorkIdentity
          : {
              ...previous.activityWorkIdentity,
              ...entry.activityWorkIdentity,
            },
      executor:
        entry.executor === undefined
          ? previous.executor
          : { ...previous.executor, ...entry.executor },
      cohortId: previous.cohortId,
      createdByStepIndex: previous.createdByStepIndex,
      createdByTurnId: previous.createdByTurnId,
      terminalView: previous.terminalView ?? entry.terminalView,
    };
  } else {
    const pending = tasks.find((candidate) => candidate.terminalView === undefined);
    tasks.push({
      ...entry,
      cohortId: pending === undefined ? undefined : getTaskCohortId(pending),
    });
  }
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_TASKS_STATE_KEY]: {
        ...stored,
        tasks,
        version: SESSION_TASKS_STATE_VERSION,
      } satisfies SessionTaskIndex,
    },
  };
}
