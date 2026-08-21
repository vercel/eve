import type { ChannelProgressRenderer } from "#channel/progress-renderer.js";
import type {
  ProgressActionV1,
  ProgressBlockerV1,
  ProgressSnapshotV1,
  ProgressWorkV1,
} from "#protocol/progress.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";

const SLACK_STATUS_PROGRESS_RENDERER_ID = "slack.status.v1";
const SLACK_PROGRESS_RENDERER = Symbol("eve.slack.progress-renderer");

export interface SlackProgressRenderer {
  readonly id: typeof SLACK_STATUS_PROGRESS_RENDERER_ID;
  readonly [SLACK_PROGRESS_RENDERER]: true;
}

interface SlackStatusProgressState {
  readonly status: string;
}

/** Creates the compact Slack assistant-thread progress renderer. */
export function slackStatusProgress(): SlackProgressRenderer {
  return { [SLACK_PROGRESS_RENDERER]: true, id: SLACK_STATUS_PROGRESS_RENDERER_ID };
}

export function hasSlackStatusProgress(
  renderers: readonly SlackProgressRenderer[] | undefined,
): boolean {
  return renderers?.some((renderer) => renderer.id === SLACK_STATUS_PROGRESS_RENDERER_ID) === true;
}

export function buildSlackProgressRenderers(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly renderers: readonly SlackProgressRenderer[];
}): readonly ChannelProgressRenderer[] {
  const ids = new Set<string>();
  return input.renderers.map((renderer) => {
    if (renderer[SLACK_PROGRESS_RENDERER] !== true) {
      throw new TypeError("Slack progress renderers must be created by an eve renderer factory.");
    }
    if (ids.has(renderer.id))
      throw new TypeError(`Duplicate Slack progress renderer "${renderer.id}".`);
    ids.add(renderer.id);
    return createSlackStatusRenderer(input.botToken);
  });
}

function createSlackStatusRenderer(botToken: SlackBotToken | undefined): ChannelProgressRenderer {
  return {
    id: SLACK_STATUS_PROGRESS_RENDERER_ID,
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
      const status = selectSlackProgressStatus(snapshot);
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
      return { status } satisfies SlackStatusProgressState;
    },
  };
}

export function selectSlackProgressStatus(snapshot: ProgressSnapshotV1): string {
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

function blockerLabel(kind: ProgressBlockerV1["kind"]): string {
  switch (kind) {
    case "approval":
      return "Waiting for approval…";
    case "authorization":
      return "Waiting for sign-in…";
    case "input":
      return "Waiting for input…";
  }
}

function newestBlocker(blockers: readonly ProgressBlockerV1[]): ProgressBlockerV1 | undefined {
  return newestByStartedAt(blockers);
}

function newestAction(actions: readonly ProgressActionV1[]): ProgressActionV1 | undefined {
  return newestByStartedAt(actions);
}

function newestWork(work: readonly ProgressWorkV1[]): ProgressWorkV1 | undefined {
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

function isSlackStatusState(value: unknown): value is SlackStatusProgressState {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "status") === "string"
  );
}
