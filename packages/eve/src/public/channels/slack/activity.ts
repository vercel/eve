import type { ChannelActivityRenderer } from "#channel/activity-renderer.js";
import type {
  ActivityActionStateV1,
  ActivityBlockerStateV1,
  ActivitySnapshotV1,
  ActivityWorkStateV1,
} from "#protocol/activity.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";

const SLACK_ACTIVITY_STATUS_RENDERER_ID = "slack.status.v1";
const SLACK_ACTIVITY_RENDERER = Symbol("eve.slack.activity-renderer");

export interface SlackActivityRenderer {
  readonly id: typeof SLACK_ACTIVITY_STATUS_RENDERER_ID;
  readonly [SLACK_ACTIVITY_RENDERER]: true;
}

interface SlackActivityStatusState {
  readonly status: string;
}

/** Creates the compact Slack assistant-thread activity renderer. */
export function slackActivityStatus(): SlackActivityRenderer {
  return { [SLACK_ACTIVITY_RENDERER]: true, id: SLACK_ACTIVITY_STATUS_RENDERER_ID };
}

export function hasSlackActivityStatus(
  renderers: readonly SlackActivityRenderer[] | undefined,
): boolean {
  return renderers?.some((renderer) => renderer.id === SLACK_ACTIVITY_STATUS_RENDERER_ID) === true;
}

export function buildSlackActivityRenderers(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly renderers: readonly SlackActivityRenderer[];
}): readonly ChannelActivityRenderer[] {
  const ids = new Set<string>();
  return input.renderers.map((renderer) => {
    if (renderer[SLACK_ACTIVITY_RENDERER] !== true) {
      throw new TypeError("Slack activity renderers must be created by an eve renderer factory.");
    }
    if (ids.has(renderer.id))
      throw new TypeError(`Duplicate Slack activity renderer "${renderer.id}".`);
    ids.add(renderer.id);
    return createSlackStatusRenderer(input.botToken);
  });
}

function createSlackStatusRenderer(botToken: SlackBotToken | undefined): ChannelActivityRenderer {
  return {
    id: SLACK_ACTIVITY_STATUS_RENDERER_ID,
    async dispose({ destination, state }) {
      if (!isSlackStatusState(state) || state.status === "") return;
      const channelId = destination["channelId"];
      const threadTs = destination["threadTs"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "") return;
      const response = await callSlackApi({
        body: { channel_id: channelId, status: "", thread_ts: threadTs },
        botToken,
        operation: "assistant.threads.setStatus",
      });
      if (response.ok !== true)
        throw new Error(`Slack status disposal failed: ${response.error ?? "unknown_error"}`);
    },
    async render({ destination, snapshot, state }) {
      const channelId = destination["channelId"];
      const threadTs = destination["threadTs"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "")
        return state;
      const status = selectSlackActivityStatus(snapshot);
      if (isSlackStatusState(state) && state.status === status) return state;
      const body: Record<string, unknown> = { channel_id: channelId, status, thread_ts: threadTs };
      if (status !== "") body.loading_messages = [status];
      const response = await callSlackApi({
        body,
        botToken,
        operation: "assistant.threads.setStatus",
      });
      if (response.ok !== true) {
        throw new Error(
          `Slack assistant.threads.setStatus failed: ${response.error ?? "unknown_error"}`,
        );
      }
      return { status } satisfies SlackActivityStatusState;
    },
  };
}

export function selectSlackActivityStatus(snapshot: ActivitySnapshotV1): string {
  const active = Object.values(snapshot.work).filter((work) => work.phase === "running");
  if (active.length === 0) return "";
  const blocker = newestBlocker(
    Object.values(snapshot.blockers).filter((candidate) => candidate.phase === "blocked"),
  );
  if (blocker !== undefined) return blockerLabel(blocker.kind);
  const action = newestAction(
    Object.values(snapshot.actions).filter((candidate) => candidate.phase === "running"),
  );
  if (action !== undefined) return truncateTypingStatus(action.name);
  const delegated = newestWork(active.filter((work) => work.kind !== "root-turn"));
  if (delegated !== undefined) return truncateTypingStatus(delegated.name ?? "Working with agent");
  return "Working…";
}

function blockerLabel(kind: ActivityBlockerStateV1["kind"]): string {
  switch (kind) {
    case "approval":
      return "Waiting for approval…";
    case "authorization":
      return "Waiting for sign-in…";
    case "input":
      return "Waiting for input…";
  }
}

function newestBlocker(
  blockers: readonly ActivityBlockerStateV1[],
): ActivityBlockerStateV1 | undefined {
  return newestByStartedAt(blockers);
}

function newestAction(
  actions: readonly ActivityActionStateV1[],
): ActivityActionStateV1 | undefined {
  return newestByStartedAt(actions);
}

function newestWork(work: readonly ActivityWorkStateV1[]): ActivityWorkStateV1 | undefined {
  return newestByStartedAt(work);
}

function newestByStartedAt<T extends { readonly startedAt: string }>(
  values: readonly T[],
): T | undefined {
  return values.reduce<T | undefined>(
    (newest, candidate) =>
      newest === undefined || candidate.startedAt >= newest.startedAt ? candidate : newest,
    undefined,
  );
}

function isSlackStatusState(value: unknown): value is SlackActivityStatusState {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "status") === "string"
  );
}
