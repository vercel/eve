import type { ChannelProgressRenderer } from "#channel/adapter.js";
import type {
  ProgressEntityV1,
  ProgressSnapshotV1,
  ProgressTurnV1,
} from "#execution/session-progress.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";

const SLACK_STATUS_PROGRESS_RENDERER_ID = "slack.status.v1";
const SLACK_ACTIVITY_PROGRESS_RENDERER_ID = "slack.activity.v1";
const SLACK_PROGRESS_RENDERER = Symbol("eve.slack.progress-renderer");

export interface SlackProgressRenderer {
  readonly id:
    | typeof SLACK_STATUS_PROGRESS_RENDERER_ID
    | typeof SLACK_ACTIVITY_PROGRESS_RENDERER_ID;
  readonly [SLACK_PROGRESS_RENDERER]: true;
}

interface SlackStatusProgressState {
  readonly status: string;
}

interface SlackActivityProgressState {
  readonly messages: Readonly<Record<string, { readonly text: string; readonly ts: string }>>;
}

/** Creates the compact Slack assistant-thread progress renderer. */
export function slackStatusProgress(): SlackProgressRenderer {
  return { [SLACK_PROGRESS_RENDERER]: true, id: SLACK_STATUS_PROGRESS_RENDERER_ID };
}

/** Creates one update-in-place Slack activity message per originating root turn. */
export function slackActivityProgress(): SlackProgressRenderer {
  return { [SLACK_PROGRESS_RENDERER]: true, id: SLACK_ACTIVITY_PROGRESS_RENDERER_ID };
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
      case SLACK_ACTIVITY_PROGRESS_RENDERER_ID:
        return createSlackActivityRenderer(input.botToken);
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

function createSlackActivityRenderer(botToken: SlackBotToken | undefined): ChannelProgressRenderer {
  return {
    id: SLACK_ACTIVITY_PROGRESS_RENDERER_ID,
    async render({ destination, snapshot, state }) {
      const channelId = destination["channelId"];
      const threadTs = destination["threadTs"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "") {
        return state;
      }
      const previous = isActivityState(state) ? state.messages : {};
      const desired = activityMessages(snapshot);
      const messages = Object.fromEntries(
        Object.entries(previous).filter(([groupId]) => desired.has(groupId)),
      );
      for (const [groupId, text] of desired) {
        const current =
          previous[groupId] ??
          (await recoverActivityMessage({ botToken, channelId, groupId, threadTs }));
        if (current?.text === text) {
          messages[groupId] = current;
          continue;
        }
        const body =
          current === undefined
            ? {
                channel: channelId,
                metadata: {
                  event_payload: { group_id: groupId },
                  event_type: "eve_progress",
                },
                text,
                thread_ts: threadTs,
              }
            : { channel: channelId, text, ts: current.ts };
        let response = await callSlackApi({
          body,
          botToken,
          operation: current === undefined ? "chat.postMessage" : "chat.update",
        });
        if (
          response.ok !== true &&
          current !== undefined &&
          response.error === "message_not_found"
        ) {
          response = await callSlackApi({
            body: {
              channel: channelId,
              metadata: {
                event_payload: { group_id: groupId },
                event_type: "eve_progress",
              },
              text,
              thread_ts: threadTs,
            },
            botToken,
            operation: "chat.postMessage",
          });
        }
        if (response.ok !== true) {
          throw new Error(`Slack activity message failed: ${response.error ?? "unknown_error"}`);
        }
        const ts = response.ts ?? current?.ts;
        if (typeof ts !== "string" || ts === "") {
          throw new Error("Slack activity message response did not include ts.");
        }
        messages[groupId] = { text, ts };
      }
      return { messages } satisfies SlackActivityProgressState;
    },
  };
}

async function recoverActivityMessage(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly channelId: string;
  readonly groupId: string;
  readonly threadTs: string;
}): Promise<{ readonly text: string; readonly ts: string } | undefined> {
  const response = await callSlackApi({
    body: { channel: input.channelId, inclusive: true, limit: 100, ts: input.threadTs },
    botToken: input.botToken,
    operation: "conversations.replies",
  });
  if (response.ok !== true || !Array.isArray(response.messages)) return undefined;
  for (const message of response.messages) {
    if (message === null || typeof message !== "object") continue;
    const metadata = Reflect.get(message, "metadata");
    const payload =
      metadata !== null && typeof metadata === "object"
        ? Reflect.get(metadata, "event_payload")
        : undefined;
    if (
      metadata !== null &&
      typeof metadata === "object" &&
      Reflect.get(metadata, "event_type") === "eve_progress" &&
      payload !== null &&
      typeof payload === "object" &&
      Reflect.get(payload, "group_id") === input.groupId
    ) {
      const ts = Reflect.get(message, "ts");
      const text = Reflect.get(message, "text");
      if (typeof ts === "string") return { text: typeof text === "string" ? text : "", ts };
    }
  }
  return undefined;
}

export function activityMessages(snapshot: ProgressSnapshotV1): ReadonlyMap<string, string> {
  const turnGroups = new Map<string, string>();
  const grouped = new Map<string, { entities: ProgressEntityV1[]; turns: ProgressTurnV1[] }>();
  for (const turn of Object.values(snapshot.turns)) {
    const groupId = turn.groupId ?? turn.id;
    turnGroups.set(turn.id, groupId);
    const group = grouped.get(groupId) ?? { entities: [], turns: [] };
    group.turns.push(turn);
    grouped.set(groupId, group);
  }
  for (const entity of Object.values(snapshot.entities)) {
    const groupId = entity.groupId ?? turnGroups.get(entity.turnId) ?? entity.turnId;
    const group = grouped.get(groupId) ?? { entities: [], turns: [] };
    group.entities.push(entity);
    grouped.set(groupId, group);
  }

  return new Map(
    [...grouped].map(([groupId, group]) => {
      const lines = group.entities
        .slice(-12)
        .map((entity) => `${phaseIcon(entity.phase)} ${escapeSlackText(entity.label)}`);
      const report = group.turns.findLast((turn) => turn.report !== undefined)?.report;
      if (report !== undefined) lines.push(`↳ ${escapeSlackText(report.message)}`);
      if (lines.length === 0) {
        const phase = group.turns.at(-1)?.phase ?? "running";
        lines.push(`${phaseIcon(phase)} Working`);
      }
      return [groupId, lines.join("\n")] as const;
    }),
  );
}

function phaseIcon(phase: ProgressEntityV1["phase"]): string {
  switch (phase) {
    case "blocked":
      return "⏸";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "–";
    default:
      return "•";
  }
}

function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function isActivityState(value: unknown): value is SlackActivityProgressState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "messages") === "object"
  );
}

export function selectSlackProgressStatus(snapshot: ProgressSnapshotV1): string {
  const turns = Object.values(snapshot.turns);
  const newestReport = turns.findLast(
    (turn) => (turn.phase === "queued" || turn.phase === "running") && turn.report !== undefined,
  )?.report;
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
  if (newestReport !== undefined) return truncateTypingStatus(newestReport.message);

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
