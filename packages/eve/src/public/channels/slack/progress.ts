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

/** Creates one update-in-place activity message per originating root turn. */
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
    return renderer.id === SLACK_ACTIVITY_PROGRESS_RENDERER_ID
      ? createSlackActivityRenderer(input.botToken)
      : createSlackStatusRenderer(input.botToken);
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

function createSlackActivityRenderer(botToken: SlackBotToken | undefined): ChannelProgressRenderer {
  return {
    id: SLACK_ACTIVITY_PROGRESS_RENDERER_ID,
    async dispose() {},
    async render({ destination, snapshot, state }) {
      const channelId = destination["channelId"];
      const threadTs = destination["threadTs"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "") {
        return state;
      }
      const previous = isActivityState(state) ? state.messages : {};
      const desired = activityMessages(snapshot);
      const messages: Record<string, { readonly text: string; readonly ts: string }> =
        Object.fromEntries(
          Object.entries(previous).filter(([rootTurnId]) => desired.has(rootTurnId)),
        );
      for (const [rootTurnId, text] of desired) {
        const current =
          previous[rootTurnId] ??
          (await recoverActivityMessage({ botToken, channelId, rootTurnId, threadTs }));
        if (current?.text === text) {
          messages[rootTurnId] = current;
          continue;
        }
        let response = await writeActivityMessage({
          botToken,
          channelId,
          current,
          rootTurnId,
          text,
          threadTs,
        });
        if (
          response.ok !== true &&
          current !== undefined &&
          response.error === "message_not_found"
        ) {
          response = await writeActivityMessage({
            botToken,
            channelId,
            rootTurnId,
            text,
            threadTs,
          });
        }
        if (response.ok !== true) {
          throw new Error(`Slack activity message failed: ${response.error ?? "unknown_error"}`);
        }
        const ts = response.ts ?? current?.ts;
        if (typeof ts !== "string" || ts === "") {
          throw new Error("Slack activity message response did not include ts.");
        }
        messages[rootTurnId] = { text, ts };
      }
      return { messages } satisfies SlackActivityProgressState;
    },
  };
}

async function writeActivityMessage(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly channelId: string;
  readonly current?: { readonly ts: string };
  readonly rootTurnId: string;
  readonly text: string;
  readonly threadTs: string;
}) {
  return await callSlackApi({
    body:
      input.current === undefined
        ? {
            channel: input.channelId,
            metadata: {
              event_payload: { root_turn_id: input.rootTurnId },
              event_type: "eve_progress",
            },
            text: input.text,
            thread_ts: input.threadTs,
          }
        : { channel: input.channelId, text: input.text, ts: input.current.ts },
    botToken: input.botToken,
    operation: input.current === undefined ? "chat.postMessage" : "chat.update",
  });
}

async function recoverActivityMessage(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly channelId: string;
  readonly rootTurnId: string;
  readonly threadTs: string;
}): Promise<{ readonly text: string; readonly ts: string } | undefined> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  while (true) {
    const body: Record<string, unknown> = {
      channel: input.channelId,
      inclusive: true,
      limit: 100,
      ts: input.threadTs,
    };
    if (cursor !== undefined) body.cursor = cursor;
    const response = await callSlackApi({
      body,
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
        Reflect.get(payload, "root_turn_id") === input.rootTurnId
      ) {
        const ts = Reflect.get(message, "ts");
        const text = Reflect.get(message, "text");
        if (typeof ts === "string") return { text: typeof text === "string" ? text : "", ts };
      }
    }
    const responseMetadata = Reflect.get(response, "response_metadata");
    const nextCursor =
      responseMetadata !== null && typeof responseMetadata === "object"
        ? Reflect.get(responseMetadata, "next_cursor")
        : undefined;
    if (typeof nextCursor !== "string" || nextCursor === "" || seenCursors.has(nextCursor)) {
      return undefined;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}

export function activityMessages(snapshot: ProgressSnapshotV1): ReadonlyMap<string, string> {
  const grouped = new Map<string, ProgressWorkV1[]>();
  for (const work of Object.values(snapshot.work)) {
    const group = grouped.get(work.rootTurnId) ?? [];
    group.push(work);
    grouped.set(work.rootTurnId, group);
  }
  return new Map(
    [...grouped].map(([rootTurnId, work]) => [
      rootTurnId,
      renderWorkTree(
        work,
        Object.values(snapshot.actions).filter((action) => action.rootTurnId === rootTurnId),
        Object.values(snapshot.blockers).filter((blocker) => blocker.rootTurnId === rootTurnId),
      ),
    ]),
  );
}

function renderWorkTree(
  work: readonly ProgressWorkV1[],
  actions: readonly ProgressActionV1[],
  blockers: readonly ProgressBlockerV1[],
): string {
  const byParent = new Map<string | undefined, ProgressWorkV1[]>();
  const ids = new Set(work.map((item) => item.id));
  for (const item of work) {
    const parentId =
      item.parentId !== undefined && ids.has(item.parentId) ? item.parentId : undefined;
    const children = byParent.get(parentId) ?? [];
    children.push(item);
    byParent.set(parentId, children);
  }
  const actionsByParent = new Map<string, ProgressActionV1[]>();
  for (const action of actions) {
    const siblings = actionsByParent.get(action.parentWorkId) ?? [];
    siblings.push(action);
    actionsByParent.set(action.parentWorkId, siblings);
  }
  const blockersByParent = new Map<string, ProgressBlockerV1[]>();
  for (const blocker of blockers) {
    const siblings = blockersByParent.get(blocker.parentWorkId) ?? [];
    siblings.push(blocker);
    blockersByParent.set(blocker.parentWorkId, siblings);
  }
  const lines: string[] = [];
  const append = (line: string): void => {
    if (lines.length < 20) lines.push(line);
  };
  const visit = (item: ProgressWorkV1, depth: number): void => {
    const label = item.kind === "root-turn" ? "Working" : (item.name ?? "Agent work");
    append(`${"  ".repeat(depth)}${phaseIcon(item.phase)} ${escapeSlackText(label)}`);
    for (const blocker of blockersByParent.get(item.id) ?? []) {
      append(
        `${"  ".repeat(depth + 1)}${blockerIcon(blocker.phase)} ${escapeSlackText(blocker.label ?? blockerLabel(blocker.kind))}`,
      );
    }
    for (const action of actionsByParent.get(item.id) ?? []) {
      append(`${"  ".repeat(depth + 1)}${phaseIcon(action.phase)} ${escapeSlackText(action.name)}`);
    }
    for (const child of byParent.get(item.id) ?? []) visit(child, depth + 1);
  };
  for (const root of byParent.get(undefined) ?? []) visit(root, 0);
  return lines.join("\n");
}

function phaseIcon(phase: ProgressWorkV1["phase"] | ProgressActionV1["phase"]): string {
  switch (phase) {
    case "completed":
      return "✓";
    case "failed":
    case "rejected":
      return "✗";
    case "cancelled":
      return "–";
    case "running":
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

function blockerIcon(phase: ProgressBlockerV1["phase"]): string {
  return phase === "blocked" ? "◌" : phase === "completed" ? "✓" : phase === "failed" ? "✗" : "–";
}

function newestBlocker(blockers: readonly ProgressBlockerV1[]): ProgressBlockerV1 | undefined {
  return blockers.reduce<ProgressBlockerV1 | undefined>(
    (newest, candidate) =>
      newest === undefined || candidate.startedAt >= newest.startedAt ? candidate : newest,
    undefined,
  );
}

function newestAction(actions: readonly ProgressActionV1[]): ProgressActionV1 | undefined {
  return actions.reduce<ProgressActionV1 | undefined>(
    (newest, candidate) =>
      newest === undefined || candidate.startedAt >= newest.startedAt ? candidate : newest,
    undefined,
  );
}

function newestWork(work: readonly ProgressWorkV1[]): ProgressWorkV1 | undefined {
  return work.reduce<ProgressWorkV1 | undefined>(
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
