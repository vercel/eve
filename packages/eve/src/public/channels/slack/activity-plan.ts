import type { ChannelActivityRenderer } from "#channel/activity-renderer.js";
import type { ActivitySnapshotV1, ActivityWorkStateV1 } from "#protocol/activity.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";

export const SLACK_ACTIVITY_PLAN_RENDERER_ID = "slack.experimental.plan.v1";

type ActivityPhase = "running" | "completed" | "failed" | "rejected" | "cancelled" | "blocked";
type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

interface PlanState {
  readonly streams: Readonly<
    Record<
      string,
      {
        readonly seen: Readonly<Record<string, string>>;
        readonly stopped: boolean;
        readonly ts: string;
      }
    >
  >;
}

interface PlanTask {
  readonly id: string;
  readonly status: TodoStatus | ActivityPhase;
  readonly title: string;
}

interface ActivityDetail {
  readonly id: string;
  readonly name: string;
  readonly phase: ActivityPhase;
  readonly taskId?: string;
}

interface PlanView {
  readonly details: readonly ActivityDetail[];
  readonly settled: boolean;
  readonly tasks: readonly PlanTask[];
  readonly title: string;
}

/** Creates a native Slack plan from todo state, falling back to the activity hierarchy. */
export function createSlackPlanRenderer(
  botToken: SlackBotToken | undefined,
): ChannelActivityRenderer {
  return {
    id: SLACK_ACTIVITY_PLAN_RENDERER_ID,
    async dispose() {},
    async render({ destination, snapshot, state }) {
      const channel = destination["channelId"];
      const installation = destination["installationTeamId"];
      const team = destination["teamId"];
      const thread = destination["threadTs"];
      const user = destination["triggeringUserId"];
      if (
        typeof channel !== "string" ||
        typeof thread !== "string" ||
        thread === "" ||
        typeof team !== "string" ||
        typeof user !== "string"
      ) {
        return state;
      }

      const previous = isState(state) ? state.streams : {};
      const streams: Record<
        string,
        { seen: Readonly<Record<string, string>>; stopped: boolean; ts: string }
      > = { ...previous };

      for (const rootTurnId of rootTurnIds(snapshot)) {
        const view = projectPlan(snapshot, rootTurnId);
        if (view === undefined) continue;

        let current = previous[rootTurnId];
        if (current === undefined) {
          const response = await api(
            "chat.startStream",
            {
              channel,
              chunks: [{ type: "plan_update", title: view.title }, ...view.tasks.map(taskChunk)],
              recipient_team_id: team,
              recipient_user_id: user,
              task_display_mode: "plan",
              thread_ts: thread,
            },
            botToken,
            installation,
          );
          if (!response.ok || typeof response.ts !== "string") {
            throw new Error(`Slack activity plan failed: ${response.error ?? "missing ts"}`);
          }
          current = {
            seen: Object.fromEntries(view.tasks.map((task) => [task.id, taskVersion(task)])),
            stopped: false,
            ts: response.ts,
          };
        }

        if (current.stopped) {
          streams[rootTurnId] = current;
          continue;
        }

        const updates = planUpdates(view, current.seen);
        if (updates.length > 0) {
          await checked(
            "chat.appendStream",
            { channel, chunks: updates, ts: current.ts },
            botToken,
            installation,
          );
        }

        const seen = Object.fromEntries([
          ...view.tasks.map((task) => [task.id, taskVersion(task)]),
          ...view.details.map((detail) => [detail.id, detailVersion(detail)]),
        ]);
        if (view.settled) {
          await checked("chat.stopStream", { channel, ts: current.ts }, botToken, installation);
          await checked(
            "chat.update",
            {
              blocks: [
                {
                  tasks: view.tasks.map((task) => ({
                    status: slackTaskStatus(task.status),
                    task_id: safeId(task.id),
                    title: task.title,
                    type: "task_card",
                  })),
                  title: view.title,
                  type: "plan",
                },
              ],
              channel,
              text: view.tasks.map((task) => task.title).join(", "),
              ts: current.ts,
            },
            botToken,
            installation,
          );
          streams[rootTurnId] = { seen, stopped: true, ts: current.ts };
        } else {
          streams[rootTurnId] = { seen, stopped: false, ts: current.ts };
        }
      }

      return { streams } satisfies PlanState;
    },
  };
}

function rootTurnIds(snapshot: ActivitySnapshotV1): ReadonlySet<string> {
  return new Set([
    ...Object.values(snapshot.work).map((work) => work.rootTurnId),
    ...Object.values(snapshot.states).map((state) => state.rootTurnId),
  ]);
}

function projectPlan(snapshot: ActivitySnapshotV1, rootTurnId: string): PlanView | undefined {
  const planState = Object.values(snapshot.states)
    .filter((state) => state.rootTurnId === rootTurnId && state.key === "todo")
    .sort((left, right) =>
      left.replacedAt === right.replacedAt
        ? left.sourceEventId.localeCompare(right.sourceEventId)
        : left.replacedAt.localeCompare(right.replacedAt),
    )
    .at(-1);
  const todos = planState === undefined ? undefined : parseTodos(planState.value);
  if (planState === undefined || todos === undefined) {
    return projectActivityPlan(snapshot, rootTurnId);
  }

  const tasks = todos.map((todo, index) => ({
    id: `${planState.parentWorkId}:todo:${index}`,
    status: todo.status,
    title: todo.content,
  }));
  const actions = Object.values(snapshot.actions).filter(
    (action) =>
      action.rootTurnId === rootTurnId &&
      action.name !== planState.sourceToolName &&
      action.id !== planState.sourceActionId,
  );
  const blockers = Object.values(snapshot.blockers).filter(
    (blocker) => blocker.rootTurnId === rootTurnId,
  );
  const work = Object.values(snapshot.work).filter((item) => item.rootTurnId === rootTurnId);
  const details: ActivityDetail[] = [
    ...work
      .filter((item) => item.kind !== "root-turn")
      .map((item) => ({
        id: item.id,
        name: item.name ?? "Agent work",
        phase: item.phase,
      })),
    ...actions.map((action) => ({
      id: action.id,
      name: action.label ?? action.name,
      phase: action.phase,
    })),
    ...blockers.map((blocker) => ({
      id: blocker.id,
      name: blocker.label ?? blockerLabel(blocker.kind),
      phase: blocker.phase,
    })),
  ];
  const settled = [...work, ...actions, ...blockers].every(
    (entity) => entity.phase !== "running" && entity.phase !== "blocked",
  );
  return { details, settled, tasks, title: "Agent plan" };
}

function projectActivityPlan(
  snapshot: ActivitySnapshotV1,
  rootTurnId: string,
): PlanView | undefined {
  const work = Object.values(snapshot.work).filter((item) => item.rootTurnId === rootTurnId);
  if (work.length === 0) return undefined;
  const roots = work.filter((item) => item.kind === "root-turn");
  const rootIds = new Set(roots.map((item) => item.id));
  let parents = work.filter((item) => item.parentId && rootIds.has(item.parentId));
  if (parents.length === 0) parents = roots;

  const owner = (workId: string): ActivityWorkStateV1 | undefined => {
    let item = work.find((candidate) => candidate.id === workId);
    while (item?.parentId && !parents.some((parent) => parent.id === item!.id)) {
      item = work.find((candidate) => candidate.id === item!.parentId);
    }
    return item && parents.find((parent) => parent.id === item!.id);
  };
  const details: ActivityDetail[] = [];
  for (const child of work) {
    if (parents.some((parent) => parent.id === child.id) || rootIds.has(child.id)) continue;
    const parent = owner(child.id);
    if (parent !== undefined) {
      details.push({
        id: child.id,
        name: child.name ?? "Agent work",
        phase: child.phase,
        taskId: parent.id,
      });
    }
  }
  const actions = Object.values(snapshot.actions).filter(
    (action) => action.rootTurnId === rootTurnId,
  );
  for (const action of actions) {
    const parent = owner(action.parentWorkId);
    if (parent !== undefined) {
      details.push({
        id: action.id,
        name: action.label ?? action.name,
        phase: action.phase,
        taskId: parent.id,
      });
    }
  }
  const blockers = Object.values(snapshot.blockers).filter(
    (blocker) => blocker.rootTurnId === rootTurnId,
  );
  for (const blocker of blockers) {
    const parent = owner(blocker.parentWorkId);
    if (parent !== undefined) {
      details.push({
        id: blocker.id,
        name: blocker.label ?? blockerLabel(blocker.kind),
        phase: blocker.phase,
        taskId: parent.id,
      });
    }
  }
  const settled = [...work, ...actions, ...blockers].every(
    (entity) => entity.phase !== "running" && entity.phase !== "blocked",
  );
  return {
    details,
    settled,
    tasks: parents.map((parent) => ({
      id: parent.id,
      status: parent.phase,
      title: parent.kind === "root-turn" ? "Agent turn" : (parent.name ?? "Agent work"),
    })),
    title: "Agent activity",
  };
}

function parseTodos(
  value: unknown,
): readonly { content: string; status: TodoStatus }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const todos: { content: string; status: TodoStatus }[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
    const content = Reflect.get(item, "content");
    const status = Reflect.get(item, "status");
    if (typeof content !== "string" || !isTodoStatus(status)) return undefined;
    todos.push({ content: firstLine(content), status });
  }
  return todos;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === "pending" || value === "in_progress" || value === "completed" || value === "cancelled"
  );
}

function firstLine(value: string): string {
  return value.split(/\r?\n/u, 1)[0] ?? "";
}

function planUpdates(view: PlanView, seen: Readonly<Record<string, string>>) {
  const taskUpdates = view.tasks
    .filter((task) => seen[task.id] !== taskVersion(task))
    .map(taskChunk);
  const activeTask =
    view.tasks.find((task) => task.status === "in_progress" || task.status === "running") ??
    view.tasks.find((task) => task.status === "pending") ??
    view.tasks.at(-1);
  const detailUpdates = view.details
    .filter((detail) => seen[detail.id] !== detailVersion(detail))
    .flatMap((detail) => {
      const detailTask = view.tasks.find((task) => task.id === detail.taskId) ?? activeTask;
      return detailTask === undefined
        ? []
        : [
            {
              details: `${phaseIcon(detail.phase)} ${detail.name}\n`,
              id: safeId(detailTask.id),
              status: slackTaskStatus(detailTask.status),
              title: detailTask.title,
              type: "task_update",
            },
          ];
    });
  return [...taskUpdates, ...detailUpdates];
}

function taskChunk(task: PlanTask) {
  return {
    id: safeId(task.id),
    status: slackTaskStatus(task.status),
    title: task.title,
    type: "task_update",
  };
}

function taskVersion(task: PlanTask): string {
  return `${task.status}:${task.title}`;
}

function detailVersion(detail: ActivityDetail): string {
  return `${detail.phase}:${detail.name}`;
}

function slackTaskStatus(
  status: TodoStatus | ActivityPhase,
): "pending" | "in_progress" | "complete" | "error" {
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
    case "running":
    case "blocked":
      return "in_progress";
    case "completed":
      return "complete";
    case "cancelled":
    case "failed":
    case "rejected":
      return "error";
  }
}

function phaseIcon(phase: ActivityPhase): string {
  switch (phase) {
    case "running":
      return "•";
    case "blocked":
      return "◌";
    case "completed":
      return "✓";
    case "cancelled":
      return "–";
    case "failed":
    case "rejected":
      return "✗";
  }
}

function blockerLabel(kind: "approval" | "authorization" | "input"): string {
  switch (kind) {
    case "approval":
      return "Waiting for approval…";
    case "authorization":
      return "Waiting for sign-in…";
    case "input":
      return "Waiting for input…";
  }
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-200);
}

async function api(
  operation: string,
  body: unknown,
  botToken: SlackBotToken | undefined,
  installation: unknown,
) {
  return callSlackApi({
    body,
    botToken,
    context: { teamId: typeof installation === "string" ? installation : undefined },
    operation,
  });
}

async function checked(
  operation: string,
  body: unknown,
  token: SlackBotToken | undefined,
  installation: unknown,
): Promise<void> {
  const response = await api(operation, body, token, installation);
  if (!response.ok) {
    throw new Error(`Slack ${operation} failed: ${response.error ?? "unknown_error"}`);
  }
}

function isState(value: unknown): value is PlanState {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "streams") === "object"
  );
}
