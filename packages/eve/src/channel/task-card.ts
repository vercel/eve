import type {
  ActivityActionStateV1,
  ActivityBlockerStateV1,
  ActivityPlanItemV1,
  ActivitySnapshotV1,
} from "#protocol/activity.js";
import type { ChannelAudience } from "#shared/channel-audience.js";

/** How many of a task's latest steps its row carries. */
const MAX_TASK_STEPS = 3;

/** How one task call stands, as its row in a task card shows it. */
export type TaskCardTaskStatus = "working" | "blocked" | "completed" | "failed" | "cancelled";

/** What a blocked task waits on: a person's approval, answer, or sign-in. */
export interface TaskCardBlocker {
  readonly kind: "approval" | "authorization" | "input";
  /** The request's prompt or the connection's name, when there is one. */
  readonly label?: string;
}

/** One action a task took on its own, such as an agent's tool call. */
export interface TaskCardStep {
  /** The action's label, or its name. */
  readonly label: string;
  readonly status: "working" | "completed" | "failed" | "cancelled";
}

/** One item of the checklist the agent set with the `plan` tool. */
export interface TaskCardPlanItem {
  readonly title: string;
  readonly status: "pending" | "working" | "completed" | "failed";
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
  /** The task's latest steps, oldest first, up to three. */
  readonly steps: readonly TaskCardStep[];
  readonly blockedOn?: TaskCardBlocker;
  /**
   * One line describing the result once settled. A failure's line appears
   * only in a private conversation, since error text can carry internals.
   */
  readonly summary?: string;
  readonly startedAt: string;
  readonly settledAt?: string;
}

/**
 * One root turn's plan and the tasks it started, in start order. `blocked`
 * while any task waits on a person, `working` while the turn or any task
 * works, then `finished`.
 */
export interface TaskCardView {
  readonly turnId: string;
  readonly state: "working" | "blocked" | "finished";
  /** The checklist the agent last set with the `plan` tool, or empty. */
  readonly plan: readonly TaskCardPlanItem[];
  readonly tasks: readonly TaskCardTask[];
}

/**
 * Projects a root session's activity into one task card per root turn that
 * set a plan or started a task. Rows are the root turn's own task calls; what
 * an agent or workflow run does on a task's behalf fills that row's steps.
 */
export function projectTaskCards(
  snapshot: ActivitySnapshotV1,
  options: { readonly audience: ChannelAudience },
): readonly TaskCardView[] {
  const rowsByTurn = new Map<string, TaskCardTask[]>();
  for (const turnId of Object.keys(snapshot.plans ?? {})) rowsByTurn.set(turnId, []);
  for (const action of Object.values(snapshot.actions)) {
    if (action.task === undefined) continue;
    if (snapshot.work[action.parentWorkId]?.kind !== "root-turn") continue;
    const rows = rowsByTurn.get(action.rootTurnId) ?? [];
    rows.push(projectRow(snapshot, action, action.task, options.audience));
    rowsByTurn.set(action.rootTurnId, rows);
  }
  return [...rowsByTurn].map(([turnId, rows]) => {
    const tasks = [...rows].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    const plan: readonly ActivityPlanItemV1[] = snapshot.plans?.[turnId] ?? [];
    return { plan, state: cardState(snapshot, turnId, tasks), tasks, turnId };
  });
}

function projectRow(
  snapshot: ActivitySnapshotV1,
  action: ActivityActionStateV1,
  task: NonNullable<ActivityActionStateV1["task"]>,
  audience: ChannelAudience,
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
    steps: latestSteps(snapshot, delegated),
    taskId: task.id,
    title: task.title,
  };
  if (blocker !== undefined && status === "blocked") row.blockedOn = toBlocker(blocker);
  const settled = status !== "working" && status !== "blocked";
  const shown = status !== "failed" || audience === "private";
  if (task.summary !== undefined && settled && shown) row.summary = task.summary;
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

/** The newest actions of the work the task's call opened, such as an agent's tool calls. */
function latestSteps(
  snapshot: ActivitySnapshotV1,
  delegated: ReadonlySet<string>,
): readonly TaskCardStep[] {
  if (delegated.size === 0) return [];
  return Object.values(snapshot.actions)
    .filter((action) => delegated.has(action.parentWorkId))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
    .slice(-MAX_TASK_STEPS)
    .map((action) => ({ label: action.label ?? action.name, status: stepStatus(action) }));
}

function stepStatus(action: ActivityActionStateV1): TaskCardStep["status"] {
  switch (action.phase) {
    case "running":
      return "working";
    case "rejected":
      return "failed";
    default:
      return action.phase;
  }
}

function toBlocker(blocker: ActivityBlockerStateV1): TaskCardBlocker {
  return blocker.label === undefined
    ? { kind: blocker.kind }
    : { kind: blocker.kind, label: blocker.label };
}

function cardState(
  snapshot: ActivitySnapshotV1,
  turnId: string,
  tasks: readonly TaskCardTask[],
): TaskCardView["state"] {
  if (tasks.some((task) => task.status === "blocked")) return "blocked";
  if (tasks.some((task) => task.status === "working")) return "working";
  const turnWorks = Object.values(snapshot.work).some(
    (work) => work.kind === "root-turn" && work.rootTurnId === turnId && work.phase === "running",
  );
  return turnWorks ? "working" : "finished";
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
