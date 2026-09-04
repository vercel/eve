import type { ChannelActivityRenderer } from "#channel/activity-renderer.js";
import type { ActivitySnapshotV1, ActivityWorkStateV1 } from "#protocol/activity.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";

export const SLACK_ACTIVITY_PLAN_RENDERER_ID = "slack.experimental.plan.v1";
type Phase = "running" | "completed" | "failed" | "rejected" | "cancelled" | "blocked";
interface PlanState {
  readonly streams: Readonly<
    Record<
      string,
      {
        readonly ts: string;
        readonly seen: Readonly<Record<string, string>>;
        readonly stopped: boolean;
      }
    >
  >;
}

export function createSlackPlanRenderer(
  botToken: SlackBotToken | undefined,
): ChannelActivityRenderer {
  return {
    id: SLACK_ACTIVITY_PLAN_RENDERER_ID,
    async dispose() {},
    async render({ destination, snapshot, state }) {
      const channel = destination["channelId"],
        thread = destination["threadTs"],
        team = destination["teamId"],
        user = destination["triggeringUserId"],
        installation = destination["installationTeamId"];
      if (
        typeof channel !== "string" ||
        typeof thread !== "string" ||
        !thread ||
        typeof team !== "string" ||
        typeof user !== "string"
      )
        return state;
      const previous = isState(state) ? state.streams : {};
      const streams: Record<
        string,
        { ts: string; seen: Readonly<Record<string, string>>; stopped: boolean }
      > = { ...previous };
      for (const rootTurnId of new Set(
        Object.values(snapshot.work).map((work) => work.rootTurnId),
      )) {
        const view = project(snapshot, rootTurnId);
        let current = previous[rootTurnId];
        if (!current) {
          const response = await api(
            "chat.startStream",
            {
              channel,
              thread_ts: thread,
              recipient_team_id: team,
              recipient_user_id: user,
              task_display_mode: "plan",
              chunks: [
                { type: "plan_update", title: "Agent activity" },
                ...view.parents.map(taskChunk),
              ],
            },
            botToken,
            installation,
          );
          if (!response.ok || typeof response.ts !== "string")
            throw new Error(`Slack activity plan failed: ${response.error ?? "missing ts"}`);
          current = {
            ts: response.ts,
            seen: Object.fromEntries(view.parents.map((parent) => [parent.id, parent.phase])),
            stopped: false,
          };
        }
        if (current.stopped) {
          streams[rootTurnId] = current;
          continue;
        }
        const updates = detailUpdates(view, current.seen);
        if (updates.length)
          await checked(
            "chat.appendStream",
            { channel, ts: current.ts, chunks: updates },
            botToken,
            installation,
          );
        const seen = Object.fromEntries([
          ...view.parents.map((parent) => [parent.id, parent.phase]),
          ...view.entities.map((entity) => [entity.id, entityVersion(entity)]),
        ]);
        if (view.settled) {
          await checked("chat.stopStream", { channel, ts: current.ts }, botToken, installation);
          const blocks = [
            {
              type: "plan",
              title: "Agent activity",
              tasks: view.parents.map((parent) => ({
                type: "task_card",
                task_id: safeId(parent.id),
                title: parent.name,
                status: status(parent.phase),
              })),
            },
          ];
          await checked(
            "chat.update",
            { channel, ts: current.ts, text: view.parents.map((p) => p.name).join(", "), blocks },
            botToken,
            installation,
          );
          streams[rootTurnId] = { ts: current.ts, seen, stopped: true };
        } else streams[rootTurnId] = { ts: current.ts, seen, stopped: false };
      }
      return { streams } satisfies PlanState;
    },
  };
}

interface Entity {
  id: string;
  name: string;
  phase: Phase;
  parent: string;
}
interface View {
  parents: ActivityWorkStateV1[];
  entities: Entity[];
  settled: boolean;
}
function project(snapshot: ActivitySnapshotV1, rootTurnId: string): View {
  const work = Object.values(snapshot.work).filter((w) => w.rootTurnId === rootTurnId);
  const roots = work.filter((w) => w.kind === "root-turn");
  const rootIds = new Set(roots.map((w) => w.id));
  let parents = work.filter((w) => w.parentId && rootIds.has(w.parentId));
  if (!parents.length) parents = roots;
  const owner = (workId: string): ActivityWorkStateV1 | undefined => {
    let item = work.find((w) => w.id === workId);
    while (item?.parentId && !parents.some((p) => p.id === item!.id))
      item = work.find((w) => w.id === item!.parentId);
    return item && parents.find((p) => p.id === item!.id);
  };
  const entities: Entity[] = [];
  for (const child of work)
    if (!parents.some((p) => p.id === child.id) && !rootIds.has(child.id)) {
      const p = owner(child.id);
      if (p)
        entities.push({
          id: child.id,
          name: child.name ?? "Agent work",
          phase: child.phase,
          parent: p.id,
        });
    }
  for (const action of Object.values(snapshot.actions).filter((a) => a.rootTurnId === rootTurnId)) {
    const p = owner(action.parentWorkId);
    if (p)
      entities.push({
        id: action.id,
        name: action.label ?? action.name,
        phase: action.phase,
        parent: p.id,
      });
  }
  for (const blocker of Object.values(snapshot.blockers).filter(
    (b) => b.rootTurnId === rootTurnId,
  )) {
    const p = owner(blocker.parentWorkId);
    if (p)
      entities.push({
        id: blocker.id,
        name: blocker.label ?? "Waiting",
        phase: blocker.phase,
        parent: p.id,
      });
  }
  const settled = [
    ...work,
    ...Object.values(snapshot.actions).filter((a) => a.rootTurnId === rootTurnId),
    ...Object.values(snapshot.blockers).filter((b) => b.rootTurnId === rootTurnId),
  ].every((e) => e.phase !== "running" && e.phase !== "blocked");
  return { parents, entities, settled };
}
function detailUpdates(view: View, seen: Readonly<Record<string, string>>) {
  const parentUpdates = view.parents
    .filter((parent) => seen[parent.id] !== parent.phase)
    .map(taskChunk);
  const descendantUpdates = view.entities
    .filter((entity) => seen[entity.id] !== entityVersion(entity))
    .map((entity) => ({
      type: "task_update",
      id: safeId(entity.parent),
      title: view.parents.find((parent) => parent.id === entity.parent)?.name ?? "Agent work",
      status: status(
        view.parents.find((parent) => parent.id === entity.parent)?.phase ?? "running",
      ),
      details: `${icon(entity.phase)} ${entity.name}\n`,
    }));
  return [...parentUpdates, ...descendantUpdates];
}
function entityVersion(entity: Entity): string {
  return `${entity.phase}:${entity.name}`;
}
function taskChunk(work: ActivityWorkStateV1) {
  return {
    type: "task_update",
    id: safeId(work.id),
    title: work.kind === "root-turn" ? "Agent turn" : (work.name ?? "Agent work"),
    status: status(work.phase),
  };
}
function status(phase: Phase) {
  return phase === "running" || phase === "blocked"
    ? "in_progress"
    : phase === "completed"
      ? "complete"
      : "error";
}
function icon(phase: Phase) {
  return phase === "running" || phase === "blocked"
    ? "•"
    : phase === "completed"
      ? "✓"
      : phase === "cancelled"
        ? "–"
        : "✗";
}
function safeId(id: string) {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-200);
}
async function api(
  operation: string,
  body: unknown,
  botToken: SlackBotToken | undefined,
  installation: unknown,
) {
  return callSlackApi({
    operation,
    body,
    botToken,
    context: { teamId: typeof installation === "string" ? installation : undefined },
  });
}
async function checked(
  operation: string,
  body: unknown,
  token: SlackBotToken | undefined,
  installation: unknown,
) {
  const response = await api(operation, body, token, installation);
  if (!response.ok)
    throw new Error(`Slack ${operation} failed: ${response.error ?? "unknown_error"}`);
}
function isState(value: unknown): value is PlanState {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "streams") === "object"
  );
}
