/**
 * Slack admission: the one check every Slack surface passes before a hook
 * runs or eve posts somewhere new. The default keeps the agent out of Slack
 * Connect conversations, whose members include other organizations.
 */
import { createLogger, logError } from "#internal/logging.js";
import {
  buildSlackWorkspaceHandle,
  type SlackApiResponse,
  type SlackBotToken,
  type SlackWorkspaceHandle,
} from "#public/channels/slack/api.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";

const log = createLogger("slack.admit");

/** The Slack surface asking to reach the agent. */
export type SlackAdmitKind =
  | "message"
  | "edit"
  | "event"
  | "answer"
  | "interaction"
  | "command"
  | "shortcut"
  | "send";

/** The Slack user behind an inbound request. */
export interface SlackAdmitActor {
  readonly userId: string;
  /** The user's workspace, when Slack reported one. Slack Connect users carry their own. */
  readonly teamId?: string;
}

/** What `slackChannel({ admit })` decides on. */
export interface SlackAdmitRequest {
  /**
   * The surface asking: a new message, an edit, an `onEvent` callback, an
   * approval or question answer, an `onInteraction` action, a slash command,
   * a shortcut, or an outbound `send` to a new Slack thread.
   */
  readonly kind: SlackAdmitKind;
  /** The conversation the request comes from, or that `send` posts into. */
  readonly channelId: string | undefined;
  /** The workspace whose app installation received the request. */
  readonly installationTeamId: string | undefined;
  /** The Slack user behind the request. `undefined` for `send` and events without a user. */
  readonly actor: SlackAdmitActor | undefined;
  /**
   * Whether the conversation is shared with another organization through
   * Slack Connect, or is pending such a share. Returns `true` when Slack
   * can't classify it, and `false` without a conversation. Memoized per
   * request and cached briefly per channel.
   */
  isExternalConversation(): Promise<boolean>;
  /** The signed Slack payload, or the receive target for `send`. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Bot-token Slack Web API access. */
  readonly slack: SlackWorkspaceHandle;
}

/** Decides whether a Slack request may reach the agent. Throwing counts as `false`. */
export type SlackAdmit = (request: SlackAdmitRequest) => boolean | Promise<boolean>;

/**
 * Default `admit`: refuses requests from, and sends into, Slack Connect
 * conversations and conversations Slack can't classify. Requests without a
 * conversation, such as global shortcuts, pass.
 */
export async function defaultSlackAdmit(request: SlackAdmitRequest): Promise<boolean> {
  if (request.channelId === undefined) return true;
  return !(await request.isExternalConversation());
}

/** The sharing flags Slack reports on a conversation object. */
interface SlackSharingFlags {
  readonly is_shared?: unknown;
  readonly is_ext_shared?: unknown;
  readonly is_pending_ext_shared?: unknown;
  readonly is_org_shared?: unknown;
}

/**
 * Whether a conversation object is shared outside the organization. Shares
 * between workspaces of one Enterprise Grid org set `is_org_shared` and stay
 * internal. A pending share counts: what eve posts now becomes visible once
 * the other organization accepts.
 */
export function isExternallySharedConversation(channel: SlackSharingFlags): boolean {
  return (
    channel.is_ext_shared === true ||
    channel.is_pending_ext_shared === true ||
    (channel.is_shared === true && channel.is_org_shared !== true)
  );
}

const VERDICT_TTL_MS = 5 * 60_000;
/** A failed lookup is retried after this, so a broken install doesn't call Slack per request. */
const FAILED_LOOKUP_TTL_MS = 60_000;
const MAX_CACHED_VERDICTS = 1_000;
// A channel's sharing changes rarely, but it does change, so verdicts expire.
const verdicts = new Map<
  string,
  { readonly external: boolean; readonly failed: boolean; readonly expiresAtMs: number }
>();

function cacheVerdict(key: string, external: boolean, failed: boolean): void {
  const now = Date.now();
  if (verdicts.size >= MAX_CACHED_VERDICTS) {
    for (const [cachedKey, verdict] of verdicts) {
      if (verdict.expiresAtMs <= now) verdicts.delete(cachedKey);
    }
    // Map iteration is insertion order, so this drops the oldest verdict.
    if (verdicts.size >= MAX_CACHED_VERDICTS) verdicts.delete(verdicts.keys().next().value!);
  }
  verdicts.set(key, {
    external,
    failed,
    expiresAtMs: now + (failed ? FAILED_LOOKUP_TTL_MS : VERDICT_TTL_MS),
  });
}

async function classifyConversation(input: {
  readonly channelId: string;
  readonly installationTeamId: string | undefined;
  readonly extSharedChannel?: boolean;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<boolean> {
  const key = `${input.installationTeamId ?? ""}:${input.channelId}`;
  // Every Events API callback says whether its channel is externally shared.
  if (input.extSharedChannel !== undefined) {
    cacheVerdict(key, input.extSharedChannel, false);
    return input.extSharedChannel;
  }
  const cached = verdicts.get(key);
  if (cached !== undefined && cached.expiresAtMs > Date.now()) return cached.external;

  try {
    const response = await input.request("conversations.info", { channel: input.channelId });
    const channel = response.channel;
    if (response.ok !== true || typeof channel !== "object" || channel === null) {
      log.error(
        response.error === "missing_scope"
          ? "conversations.info needs the channels:read, groups:read, im:read, and mpim:read scopes to tell Slack Connect conversations apart, so eve treats this one as external; add the scopes and reinstall the Slack app"
          : "conversations.info failed, so eve treats the conversation as external",
        { channelId: input.channelId, error: response.error },
      );
      cacheVerdict(key, true, true);
      return true;
    }
    const external = isExternallySharedConversation(channel as SlackSharingFlags);
    cacheVerdict(key, external, false);
    return external;
  } catch (error) {
    logError(log, "conversations.info failed, so eve treats the conversation as external", error, {
      channelId: input.channelId,
    });
    cacheVerdict(key, true, true);
    return true;
  }
}

/**
 * Memoized `isExternalConversation()` for one conversation. Without a
 * conversation there is nothing to classify, so it resolves `false`.
 */
export function slackConversationClassifier(input: {
  readonly channelId: string | undefined;
  readonly installationTeamId: string | undefined;
  /** `is_ext_shared_channel` from an Events API callback, when there is one. */
  readonly extSharedChannel?: boolean;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): () => Promise<boolean> {
  let external: Promise<boolean> | undefined;
  const { channelId } = input;
  return () =>
    (external ??=
      channelId === undefined
        ? Promise.resolve(false)
        : classifyConversation({ ...input, channelId }));
}

/** Builds the request `admit` sees. */
export function createSlackAdmitRequest(input: {
  readonly kind: SlackAdmitKind;
  readonly channelId: string | undefined;
  readonly installationTeamId: string | undefined;
  readonly actor: SlackAdmitActor | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly slack: SlackWorkspaceHandle;
  /** Shares a classifier the hook context also exposes; built from `slack` otherwise. */
  readonly isExternalConversation?: () => Promise<boolean>;
}): SlackAdmitRequest {
  return {
    kind: input.kind,
    channelId: input.channelId,
    installationTeamId: input.installationTeamId,
    actor: input.actor,
    isExternalConversation:
      input.isExternalConversation ??
      slackConversationClassifier({
        channelId: input.channelId,
        installationTeamId: input.installationTeamId,
        request: input.slack.request,
      }),
    raw: input.raw,
    slack: input.slack,
  };
}

/** Runs `admit`, treating a throw as a refusal. Logs refusals without content. */
export async function isSlackRequestAdmitted(
  admit: SlackAdmit,
  request: SlackAdmitRequest,
): Promise<boolean> {
  let admitted = false;
  try {
    admitted = (await admit(request)) === true;
  } catch (error) {
    logError(log, "Slack admit hook failed; refusing the request", error, {
      channelId: request.channelId,
      kind: request.kind,
    });
    return false;
  }
  if (!admitted) {
    log.info("Slack request not admitted", { channelId: request.channelId, kind: request.kind });
  }
  return admitted;
}

/** Admits an interactivity payload: an answer, an action, a slash command, or a shortcut. */
export async function admitSlackInteraction(input: {
  readonly admit: SlackAdmit | undefined;
  readonly api: SlackTransportOptions | undefined;
  readonly botToken: SlackBotToken | undefined;
  readonly kind: Extract<SlackAdmitKind, "answer" | "interaction" | "command" | "shortcut">;
  readonly channelId: string | undefined;
  readonly installationTeamId: string | undefined;
  readonly teamId: string | undefined;
  readonly userId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}): Promise<boolean> {
  return await isSlackRequestAdmitted(
    input.admit ?? defaultSlackAdmit,
    createSlackAdmitRequest({
      kind: input.kind,
      channelId: input.channelId,
      installationTeamId: input.installationTeamId,
      actor:
        input.teamId === undefined
          ? { userId: input.userId }
          : { userId: input.userId, teamId: input.teamId },
      raw: input.raw,
      slack: buildSlackWorkspaceHandle({
        api: input.api,
        botToken: input.botToken,
        installationTeamId: input.installationTeamId,
        teamId: input.teamId,
      }),
    }),
  );
}
