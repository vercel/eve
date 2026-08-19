import type { ChannelProgressRenderer } from "#channel/adapter.js";
import type { ProgressEntityV1, ProgressSnapshotV1 } from "#execution/session-progress.js";
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
    switch (renderer.id) {
      case SLACK_STATUS_PROGRESS_RENDERER_ID:
        return createSlackStatusRenderer(input.botToken);
    }
  });
}

function createSlackStatusRenderer(botToken: SlackBotToken | undefined): ChannelProgressRenderer {
  return {
    id: SLACK_STATUS_PROGRESS_RENDERER_ID,
    async render({ destination, snapshot, state }) {
      const channelId = destination["channelId"];
      const threadTs = destination["threadTs"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "") {
        return state;
      }

      const status = selectSlackProgressStatus(snapshot);
      const previous = isSlackStatusState(state) ? state.status : undefined;
      if (previous === status) return state;

      const body: Record<string, unknown> = {
        channel_id: channelId,
        status,
        thread_ts: threadTs,
      };
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
  const entities = Object.values(snapshot.entities);
  const active = entities.filter(
    (entity) =>
      entity.phase === "blocked" || entity.phase === "queued" || entity.phase === "running",
  );
  const activeTurnIds = new Set(
    Object.values(snapshot.turns)
      .filter((turn) => turn.phase === "queued" || turn.phase === "running")
      .map((turn) => turn.id),
  );
  for (const entity of active) activeTurnIds.add(entity.turnId);
  if (activeTurnIds.size === 0) return "";

  const relevant = entities.filter((entity) => activeTurnIds.has(entity.turnId));
  const blocked = newestEntity(relevant, (entity) => entity.phase === "blocked");
  if (blocked !== undefined) return truncateTypingStatus(blocked.label);

  const failed = newestEntity(relevant, (entity) => entity.phase === "failed");
  if (failed !== undefined) return truncateTypingStatus(`Failed: ${failed.label}`);

  const running = active.filter((entity) => entity.phase !== "blocked");
  const selected = running.at(-1);
  if (selected !== undefined) {
    return truncateTypingStatus(
      running.length > 1 ? `${selected.label} (+${running.length - 1})` : selected.label,
    );
  }

  return "Working...";
}

function newestEntity(
  entities: readonly ProgressEntityV1[],
  predicate: (entity: ProgressEntityV1) => boolean,
): ProgressEntityV1 | undefined {
  return entities.findLast(predicate);
}

function isSlackStatusState(value: unknown): value is SlackStatusProgressState {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "status") === "string"
  );
}
