import type {
  ActivityActionStateV1,
  ActivityBlockerStateV1,
  ActivitySnapshotV1,
} from "#protocol/activity.js";

/** How one task call stands, as its row in a task card shows it. */
export type TaskCardTaskStatus = "working" | "blocked" | "completed" | "failed" | "cancelled";

/** What a blocked task waits on: a person's approval, answer, or sign-in. */
export interface TaskCardBlocker {
  readonly kind: "approval" | "authorization" | "input";
  /** The request's prompt or the connection's name, when there is one. */
  readonly label?: string;
}

/** One task call in a turn's task card. */
export interface TaskCardTask {
  /** Unique within the card; a resumable task called twice in a turn has two rows. */
  readonly id: string;
  readonly taskId: string;
  readonly kind: "agent" | "tool";
  /** The tool or agent name. */
  readonly name: string;
  /** The tool's start label, `agent: brief` for an agent, or the name. */
  readonly title: string;
  readonly status: TaskCardTaskStatus;
  /** What the task is doing now, in one line, while it works. */
  readonly activity?: string;
  readonly blockedOn?: TaskCardBlocker;
  /** One line describing the result or failure, once settled. */
  readonly summary?: string;
  readonly startedAt: string;
  readonly settledAt?: string;
}

/**
 * The tasks one root turn started, in start order. `blocked` while any task
 * waits on a person, `working` while any other works, then `finished`.
 */
export interface TaskCardView {
  readonly turnId: string;
  readonly state: "working" | "blocked" | "finished";
  readonly tasks: readonly TaskCardTask[];
}

/**
 * Projects a root session's activity into one task card per root turn that
 * started a task. Rows are the root turn's own task calls; what an agent or
 * workflow run does on a task's behalf only fills that row's activity.
 */
export function projectTaskCards(snapshot: ActivitySnapshotV1): readonly TaskCardView[] {
  const rowsByTurn = new Map<string, TaskCardTask[]>();
  for (const action of Object.values(snapshot.actions)) {
    if (action.task === undefined) continue;
    if (snapshot.work[action.parentWorkId]?.kind !== "root-turn") continue;
    const rows = rowsByTurn.get(action.rootTurnId) ?? [];
    rows.push(projectRow(snapshot, action, action.task));
    rowsByTurn.set(action.rootTurnId, rows);
  }
  return [...rowsByTurn].map(([turnId, rows]) => {
    const tasks = [...rows].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return { state: cardState(tasks), tasks, turnId };
  });
}

function projectRow(
  snapshot: ActivitySnapshotV1,
  action: ActivityActionStateV1,
  task: NonNullable<ActivityActionStateV1["task"]>,
): TaskCardTask {
  const delegated = delegatedWorkIds(snapshot, action);
  const blocker = latest(
    Object.values(snapshot.blockers).filter(
      (candidate) =>
        candidate.phase === "blocked" &&
        (candidate.parentActionId === action.id || delegated.has(candidate.parentWorkId)),
    ),
  );
  const status = rowStatus(action, blocker);
  const row: {
    -readonly [K in keyof TaskCardTask]: TaskCardTask[K];
  } = {
    id: action.id,
    kind: task.kind,
    name: action.name,
    startedAt: action.startedAt,
    status,
    taskId: task.id,
    title: task.title,
  };
  if (blocker !== undefined && status === "blocked") row.blockedOn = toBlocker(blocker);
  if (status === "working") {
    const activity = currentActivity(snapshot, delegated);
    if (activity !== undefined) row.activity = activity;
  }
  if (task.summary !== undefined && status !== "working" && status !== "blocked") {
    row.summary = task.summary;
  }
  if (action.settledAt !== undefined) row.settledAt = action.settledAt;
  return row;
}

/** The work a task's call opened, such as an agent's session, and everything beneath it. */
function delegatedWorkIds(
  snapshot: ActivitySnapshotV1,
  action: ActivityActionStateV1,
): ReadonlySet<string> {
  const works = Object.values(snapshot.work);
  const ids = new Set(
    works
      .filter(
        (work) =>
          work.parentId !== undefined &&
          work.callId !== undefined &&
          `action:${work.parentId}:${work.callId}` === action.id,
      )
      .map((work) => work.id),
  );
  let grew = ids.size > 0;
  while (grew) {
    grew = false;
    for (const work of works) {
      if (work.parentId === undefined || ids.has(work.id) || !ids.has(work.parentId)) continue;
      ids.add(work.id);
      grew = true;
    }
  }
  return ids;
}

function rowStatus(
  action: ActivityActionStateV1,
  blocker: ActivityBlockerStateV1 | undefined,
): TaskCardTaskStatus {
  switch (action.phase) {
    case "running":
      return blocker === undefined ? "working" : "blocked";
    case "completed":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "rejected":
      return "failed";
  }
}

/** The newest running action of the work the task's call opened, such as an agent's tool call. */
function currentActivity(
  snapshot: ActivitySnapshotV1,
  delegated: ReadonlySet<string>,
): string | undefined {
  const running = latest(
    Object.values(snapshot.actions).filter(
      (candidate) => candidate.phase === "running" && delegated.has(candidate.parentWorkId),
    ),
  );
  return running === undefined ? undefined : (running.label ?? running.name);
}

function toBlocker(blocker: ActivityBlockerStateV1): TaskCardBlocker {
  return blocker.label === undefined
    ? { kind: blocker.kind }
    : { kind: blocker.kind, label: blocker.label };
}

function cardState(tasks: readonly TaskCardTask[]): TaskCardView["state"] {
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "working")) return "working";
  return "finished";
}

function latest<T extends ActivityActionStateV1 | ActivityBlockerStateV1>(
  values: readonly T[],
): T | undefined {
  let newest: T | undefined;
  for (const value of values) {
    if (newest === undefined || value.startedAt >= newest.startedAt) newest = value;
  }
  return newest;
}
