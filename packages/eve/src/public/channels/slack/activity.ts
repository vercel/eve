import type { ChannelActivityRenderer } from "#channel/activity-renderer.js";
import type {
  ActivityActionStateV1,
  ActivityBlockerStateV1,
  ActivitySnapshotV1,
  ActivityWorkStateV1,
} from "#protocol/activity.js";
import { callSlackApi, type SlackBotToken } from "#public/channels/slack/api.js";
import {
  createSlackPlanRenderer,
  SLACK_ACTIVITY_PLAN_RENDERER_ID,
} from "#public/channels/slack/activity-plan.js";
import { truncateTypingStatus } from "#public/channels/slack/limits.js";

const SLACK_ACTIVITY_STATUS_RENDERER_ID = "slack.status.v1";
const SLACK_ACTIVITY_MESSAGE_RENDERER_ID = "slack.experimental.tree.v1";
const SLACK_ACTIVITY_RENDERER = Symbol("eve.slack.activity-renderer");

export interface SlackActivityRenderer {
  readonly id: string;
  readonly [SLACK_ACTIVITY_RENDERER]: true;
}

/**
 * Activity snapshot passed to an experimental Slack activity renderer.
 *
 * This contract is unstable and may change or be removed in any release.
 */
export type ExperimentalSlackActivitySnapshot = ActivitySnapshotV1;

/** Slack destination passed to an experimental activity renderer. */
export interface ExperimentalSlackActivityDestination {
  readonly channelId: string | null;
  readonly installationTeamId: string | null;
  readonly teamId: string | null;
  readonly threadTs: string | null;
  readonly triggeringUserId: string | null;
}

/**
 * Experimental custom Slack activity renderer.
 *
 * Renderer state is retained by renderer id between snapshots. This contract
 * is unstable and may change or be removed in any release.
 */
export interface ExperimentalSlackActivityRenderer<State = unknown> {
  readonly id: string;
  render(input: {
    readonly destination: ExperimentalSlackActivityDestination;
    readonly snapshot: ExperimentalSlackActivitySnapshot;
    readonly state: State | undefined;
  }): Promise<State | undefined>;
  dispose?(input: {
    readonly destination: ExperimentalSlackActivityDestination;
    readonly state: State | undefined;
  }): Promise<void>;
}

interface SlackActivityStatusState {
  readonly status: string;
}

interface SlackActivityMessageState {
  readonly messages: Readonly<Record<string, { readonly text: string; readonly ts: string }>>;
}

/** Creates the compact Slack assistant-thread activity renderer. */
export function experimental_slackActivityStatus(): SlackActivityRenderer {
  return { [SLACK_ACTIVITY_RENDERER]: true, id: SLACK_ACTIVITY_STATUS_RENDERER_ID };
}

/** Creates one experimental update-in-place Unicode activity tree per root turn. */
export function experimental_slackActivityTree(): SlackActivityRenderer {
  return { [SLACK_ACTIVITY_RENDERER]: true, id: SLACK_ACTIVITY_MESSAGE_RENDERER_ID };
}

/** Creates one experimental native Slack plan stream per root turn. */
export function experimental_slackActivityPlan(): SlackActivityRenderer {
  return { [SLACK_ACTIVITY_RENDERER]: true, id: SLACK_ACTIVITY_PLAN_RENDERER_ID };
}

/**
 * Registers an experimental custom Slack activity renderer.
 *
 * The renderer contract is unstable and may change or be removed in any
 * release.
 */
export function experimental_slackActivityRenderer<State>(
  renderer: ExperimentalSlackActivityRenderer<State>,
): SlackActivityRenderer {
  validateCustomSlackActivityRenderer(renderer);
  return {
    [SLACK_ACTIVITY_RENDERER]: true,
    id: renderer.id,
    render: renderer.render,
    dispose: renderer.dispose,
  } as SlackActivityRenderer;
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
    if (renderer.id === SLACK_ACTIVITY_MESSAGE_RENDERER_ID) {
      return createSlackActivityRenderer(input.botToken);
    }
    if (renderer.id === SLACK_ACTIVITY_PLAN_RENDERER_ID) {
      return createSlackPlanRenderer(input.botToken);
    }
    if (renderer.id === SLACK_ACTIVITY_STATUS_RENDERER_ID) {
      return createSlackStatusRenderer(input.botToken);
    }
    assertCustomSlackActivityRenderer(renderer);
    return createCustomSlackActivityRenderer(renderer);
  });
}

function assertCustomSlackActivityRenderer(
  renderer: SlackActivityRenderer,
): asserts renderer is SlackActivityRenderer & ExperimentalSlackActivityRenderer {
  validateCustomSlackActivityRenderer(renderer);
}

function validateCustomSlackActivityRenderer(
  renderer: unknown,
): asserts renderer is ExperimentalSlackActivityRenderer {
  if (
    typeof renderer !== "object" ||
    renderer === null ||
    !("id" in renderer) ||
    typeof renderer.id !== "string" ||
    renderer.id.trim() === ""
  ) {
    throw new TypeError("Slack activity renderer ids must be non-empty strings.");
  }
  if (
    renderer.id === SLACK_ACTIVITY_STATUS_RENDERER_ID ||
    renderer.id === SLACK_ACTIVITY_MESSAGE_RENDERER_ID ||
    renderer.id === SLACK_ACTIVITY_PLAN_RENDERER_ID
  ) {
    throw new TypeError(`Slack activity renderer id "${renderer.id}" is reserved by eve.`);
  }
  if (!("render" in renderer) || typeof renderer.render !== "function") {
    throw new TypeError("Custom Slack activity renderers must define a render function.");
  }
  if (
    "dispose" in renderer &&
    renderer.dispose !== undefined &&
    typeof renderer.dispose !== "function"
  ) {
    throw new TypeError("Custom Slack activity renderer dispose must be a function.");
  }
}

function createCustomSlackActivityRenderer(
  renderer: ExperimentalSlackActivityRenderer,
): ChannelActivityRenderer {
  return {
    id: renderer.id,
    async render({ destination, snapshot, state }) {
      return renderer.render({
        destination: experimentalSlackActivityDestination(destination),
        snapshot,
        state,
      });
    },
    async dispose({ destination, state }) {
      await renderer.dispose?.({
        destination: experimentalSlackActivityDestination(destination),
        state,
      });
    },
  };
}

function experimentalSlackActivityDestination(
  destination: Readonly<Record<string, unknown>>,
): ExperimentalSlackActivityDestination {
  return {
    channelId: typeof destination["channelId"] === "string" ? destination["channelId"] : null,
    installationTeamId:
      typeof destination["installationTeamId"] === "string"
        ? destination["installationTeamId"]
        : null,
    teamId: typeof destination["teamId"] === "string" ? destination["teamId"] : null,
    threadTs: typeof destination["threadTs"] === "string" ? destination["threadTs"] : null,
    triggeringUserId:
      typeof destination["triggeringUserId"] === "string" ? destination["triggeringUserId"] : null,
  };
}

function createSlackStatusRenderer(botToken: SlackBotToken | undefined): ChannelActivityRenderer {
  return {
    id: SLACK_ACTIVITY_STATUS_RENDERER_ID,
    async dispose({ destination, state }) {
      if (!isSlackStatusState(state) || state.status === "") return;
      const channelId = destination["channelId"];
      const installationTeamId = destination["installationTeamId"];
      const threadTs = destination["threadTs"];
      if (typeof channelId !== "string" || typeof threadTs !== "string" || threadTs === "") return;
      const response = await callSlackApi({
        body: { channel_id: channelId, status: "", thread_ts: threadTs },
        botToken,
        context: {
          teamId: typeof installationTeamId === "string" ? installationTeamId : undefined,
        },
        operation: "assistant.threads.setStatus",
      });
      if (response.ok !== true)
        throw new Error(`Slack status disposal failed: ${response.error ?? "unknown_error"}`);
    },
    async render({ destination, snapshot, state }) {
      const channelId = destination["channelId"];
      const installationTeamId = destination["installationTeamId"];
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
        context: {
          teamId: typeof installationTeamId === "string" ? installationTeamId : undefined,
        },
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

function createSlackActivityRenderer(botToken: SlackBotToken | undefined): ChannelActivityRenderer {
  return {
    id: SLACK_ACTIVITY_MESSAGE_RENDERER_ID,
    async dispose() {},
    async render({ destination, snapshot, state }) {
      const channelId = destination["channelId"];
      const installationTeamId = destination["installationTeamId"];
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
          (await recoverActivityMessage({
            botToken,
            channelId,
            installationTeamId,
            rootTurnId,
            threadTs,
          }));
        if (current?.text === text) {
          messages[rootTurnId] = current;
          continue;
        }
        let response = await writeActivityMessage({
          botToken,
          channelId,
          current,
          installationTeamId,
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
            installationTeamId,
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
      return { messages } satisfies SlackActivityMessageState;
    },
  };
}

async function writeActivityMessage(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly channelId: string;
  readonly current?: { readonly ts: string };
  readonly installationTeamId: unknown;
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
    context: {
      teamId: typeof input.installationTeamId === "string" ? input.installationTeamId : undefined,
    },
    operation: input.current === undefined ? "chat.postMessage" : "chat.update",
  });
}

async function recoverActivityMessage(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly channelId: string;
  readonly installationTeamId: unknown;
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
      context: {
        teamId: typeof input.installationTeamId === "string" ? input.installationTeamId : undefined,
      },
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

export function activityMessages(snapshot: ActivitySnapshotV1): ReadonlyMap<string, string> {
  const grouped = new Map<string, ActivityWorkStateV1[]>();
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
  work: readonly ActivityWorkStateV1[],
  actions: readonly ActivityActionStateV1[],
  blockers: readonly ActivityBlockerStateV1[],
): string {
  const byParent = new Map<string | undefined, ActivityWorkStateV1[]>();
  const ids = new Set(work.map((item) => item.id));
  for (const item of work) {
    const parentId =
      item.parentId !== undefined && ids.has(item.parentId) ? item.parentId : undefined;
    const children = byParent.get(parentId) ?? [];
    children.push(item);
    byParent.set(parentId, children);
  }
  const backgroundActionIds = new Set(
    work.flatMap((item) =>
      item.parentId !== undefined && item.callId !== undefined
        ? [`action:${item.parentId}:${item.callId}`]
        : [],
    ),
  );
  const actionsByParent = new Map<string, ActivityActionStateV1[]>();
  for (const action of actions) {
    if (action.kind === "tool" && backgroundActionIds.has(action.id)) continue;
    const siblings = actionsByParent.get(action.parentWorkId) ?? [];
    siblings.push(action);
    actionsByParent.set(action.parentWorkId, siblings);
  }
  const blockersByParent = new Map<string, ActivityBlockerStateV1[]>();
  for (const blocker of blockers) {
    const siblings = blockersByParent.get(blocker.parentWorkId) ?? [];
    siblings.push(blocker);
    blockersByParent.set(blocker.parentWorkId, siblings);
  }
  const lines: string[] = [];
  const append = (line: string): void => {
    if (lines.length < 20) lines.push(line);
  };
  const visit = (item: ActivityWorkStateV1, prefix: string, connector: string): void => {
    const label = item.kind === "root-turn" ? "Working" : (item.name ?? "Agent work");
    append(`${prefix}${connector}${phaseIcon(item.phase)} ${escapeSlackText(label)}`);
    const descendants = [
      ...(blockersByParent.get(item.id) ?? []).map((blocker) => ({ blocker })),
      ...(actionsByParent.get(item.id) ?? []).map((action) => ({ action })),
      ...(byParent.get(item.id) ?? []).map((child) => ({ child })),
    ];
    const childPrefix = `${prefix}${connector === "├── " ? "│   " : connector === "└── " ? "    " : ""}`;
    descendants.forEach((descendant, index) => {
      const branch = index === descendants.length - 1 ? "└── " : "├── ";
      if ("blocker" in descendant)
        append(
          `${childPrefix}${branch}${blockerIcon(descendant.blocker.phase)} ${escapeSlackText(descendant.blocker.label ?? blockerLabel(descendant.blocker.kind))}`,
        );
      else if ("action" in descendant)
        append(
          `${childPrefix}${branch}${phaseIcon(descendant.action.phase)} ${escapeSlackText(descendant.action.label ?? descendant.action.name)}`,
        );
      else visit(descendant.child, childPrefix, branch);
    });
  };
  for (const root of byParent.get(undefined) ?? []) visit(root, "", "");
  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

function phaseIcon(phase: ActivityWorkStateV1["phase"] | ActivityActionStateV1["phase"]): string {
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

function isActivityState(value: unknown): value is SlackActivityMessageState {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "messages") === "object"
  );
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
  if (action !== undefined) return truncateTypingStatus(action.label ?? action.name);
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

function blockerIcon(phase: ActivityBlockerStateV1["phase"]): string {
  return phase === "blocked" ? "◌" : phase === "completed" ? "✓" : phase === "failed" ? "✗" : "–";
}

function newestBlocker(
  blockers: readonly ActivityBlockerStateV1[],
): ActivityBlockerStateV1 | undefined {
  return blockers.reduce<ActivityBlockerStateV1 | undefined>(
    (newest, candidate) =>
      newest === undefined || candidate.startedAt >= newest.startedAt ? candidate : newest,
    undefined,
  );
}

function newestAction(
  actions: readonly ActivityActionStateV1[],
): ActivityActionStateV1 | undefined {
  return actions.reduce<ActivityActionStateV1 | undefined>(
    (newest, candidate) =>
      newest === undefined || candidate.startedAt >= newest.startedAt ? candidate : newest,
    undefined,
  );
}

function newestWork(work: readonly ActivityWorkStateV1[]): ActivityWorkStateV1 | undefined {
  return work.reduce<ActivityWorkStateV1 | undefined>(
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
