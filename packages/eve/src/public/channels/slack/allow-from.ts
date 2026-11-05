/**
 * Slack's `allowFrom`: the one check every inbound Slack request passes before
 * a hook runs. The default keeps the agent out of Slack Connect conversations,
 * whose members include other organizations, and away from guest accounts.
 */
import { createLogger, logError } from "#internal/logging.js";
import {
  buildSlackWorkspaceHandle,
  type SlackApiResponse,
  type SlackBotToken,
  type SlackWorkspaceHandle,
} from "#public/channels/slack/api.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";

const log = createLogger("slack.allow-from");

/** The Slack surface a request arrived on. */
export type SlackInboundKind =
  | "message"
  | "edit"
  | "event"
  | "answer"
  | "interaction"
  | "command"
  | "shortcut";

/** The Slack user behind an inbound request. */
export interface SlackInboundUser {
  readonly id: string;
  /** The user's workspace, when Slack reported one. Slack Connect users carry their own. */
  readonly teamId?: string;
}

/** What `slackChannel({ allowFrom })` decides on. */
export interface SlackInboundRequest {
  /**
   * The surface the request arrived on: a new message, an edit, an `onEvent`
   * callback, an approval or question answer, an `onInteraction` action, a
   * slash command, or a shortcut.
   */
  readonly kind: SlackInboundKind;
  /** The conversation the request comes from, when it has one. */
  readonly channelId: string | undefined;
  /** The workspace whose app installation received the request. */
  readonly installationTeamId: string | undefined;
  /** The Slack user behind the request. `undefined` for events without a user. */
  readonly user: SlackInboundUser | undefined;
  /**
   * Whether the conversation is shared with another organization through
   * Slack Connect, or is pending such a share. Returns `true` when Slack
   * can't classify it, and `false` without a conversation. Memoized per
   * request and cached briefly per channel.
   */
  isExternalConversation(): Promise<boolean>;
  /**
   * Whether the user is a multi-channel or single-channel guest. Returns
   * `true` when Slack can't say, and `false` without a user. Needs the
   * `users:read` scope. Memoized per request and cached briefly per user.
   */
  isGuest(): Promise<boolean>;
  /** The signed Slack payload. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Bot-token Slack Web API access. */
  readonly slack: SlackWorkspaceHandle;
}

/**
 * Who may reach the agent. A list of Slack user IDs admits those users on top
 * of {@link defaultSlackAllowFrom}. A function decides alone, so call
 * `defaultSlackAllowFrom` from it to keep the default checks. A function that
 * throws counts as `false`.
 */
export type SlackAllowFrom =
  | readonly string[]
  | ((request: SlackInboundRequest) => boolean | Promise<boolean>);

/**
 * Default `allowFrom`: refuses requests from Slack Connect conversations and
 * from guest accounts, and requests whose conversation or user Slack can't
 * classify. Requests without a conversation or a user skip that check.
 */
export async function defaultSlackAllowFrom(request: SlackInboundRequest): Promise<boolean> {
  if (await request.isExternalConversation()) return false;
  return !(await request.isGuest());
}

async function decide(
  allowFrom: SlackAllowFrom | undefined,
  request: SlackInboundRequest,
): Promise<boolean> {
  if (typeof allowFrom === "function") return (await allowFrom(request)) === true;
  if (!(await defaultSlackAllowFrom(request))) return false;
  return allowFrom === undefined || allowFrom.includes(request.user?.id ?? "");
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

/** A classification, and the scope Slack said it was missing when it couldn't classify. */
export interface SlackClassification {
  readonly flagged: boolean;
  readonly missingScope?: string;
}

const VERDICT_TTL_MS = 5 * 60_000;
/** A failed lookup is retried after this, so a broken install doesn't call Slack per request. */
const FAILED_LOOKUP_TTL_MS = 60_000;
const MAX_CACHED_VERDICTS = 1_000;

// Sharing and guest status change rarely, but they do change, so verdicts expire.
function createVerdictCache() {
  const verdicts = new Map<string, SlackClassification & { readonly expiresAtMs: number }>();
  return {
    get(key: string): SlackClassification | undefined {
      const cached = verdicts.get(key);
      return cached !== undefined && cached.expiresAtMs > Date.now() ? cached : undefined;
    },
    set(key: string, verdict: SlackClassification, failed: boolean): void {
      const now = Date.now();
      if (verdicts.size >= MAX_CACHED_VERDICTS) {
        for (const [cachedKey, cached] of verdicts) {
          if (cached.expiresAtMs <= now) verdicts.delete(cachedKey);
        }
        // Map iteration is insertion order, so this drops the oldest verdict.
        if (verdicts.size >= MAX_CACHED_VERDICTS) verdicts.delete(verdicts.keys().next().value!);
      }
      verdicts.set(key, {
        ...verdict,
        expiresAtMs: now + (failed ? FAILED_LOOKUP_TTL_MS : VERDICT_TTL_MS),
      });
    },
  };
}

const conversationVerdicts = createVerdictCache();
const guestVerdicts = createVerdictCache();

/**
 * Looks one Slack object up and classifies it. Anything that isn't a clean
 * answer, including an object without the flags `read` needs, counts as
 * flagged: the check fails closed.
 */
async function classify(input: {
  readonly cache: ReturnType<typeof createVerdictCache>;
  readonly key: string;
  readonly operation: "conversations.info" | "users.info";
  readonly body: Record<string, string>;
  readonly field: "channel" | "user";
  /** Returns `undefined` when the object lacks the flags to decide. */
  readonly read: (object: Record<string, unknown>) => boolean | undefined;
  /** What a refusal means, for the log: "the conversation as external", "the user as a guest". */
  readonly treats: string;
  readonly scopes: string;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<SlackClassification> {
  const cached = input.cache.get(input.key);
  if (cached !== undefined) return cached;

  const fail = (verdict: SlackClassification): SlackClassification => {
    input.cache.set(input.key, verdict, true);
    return verdict;
  };
  let response: SlackApiResponse;
  try {
    response = await input.request(input.operation, input.body);
  } catch (error) {
    logError(log, `${input.operation} failed, so eve treats ${input.treats}`, error, input.body);
    return fail({ flagged: true });
  }
  if (response.ok !== true && response.error === "missing_scope") {
    const missingScope = typeof response.needed === "string" ? response.needed : input.scopes;
    log.error(
      `The Slack app is missing the ${missingScope} scope, so eve can't run its default Slack Connect and guest checks and refuses requests it can't classify. Add the scope and reinstall the Slack app.`,
      { ...input.body, missingScope, operation: input.operation },
    );
    return fail({ flagged: true, missingScope });
  }
  const object = response[input.field];
  const flagged =
    response.ok === true && typeof object === "object" && object !== null
      ? input.read(object as Record<string, unknown>)
      : undefined;
  if (flagged === undefined) {
    log.error(`${input.operation} returned no usable answer, so eve treats ${input.treats}`, {
      ...input.body,
      error: response.error,
    });
    return fail({ flagged: true });
  }
  const verdict = { flagged };
  input.cache.set(input.key, verdict, false);
  return verdict;
}

function classifyConversation(input: {
  readonly channelId: string;
  readonly installationTeamId: string | undefined;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<SlackClassification> {
  return classify({
    cache: conversationVerdicts,
    key: `${input.installationTeamId ?? ""}:${input.channelId}`,
    operation: "conversations.info",
    body: { channel: input.channelId },
    field: "channel",
    read: (channel) =>
      typeof channel.is_ext_shared === "boolean"
        ? isExternallySharedConversation(channel as SlackSharingFlags)
        : undefined,
    treats: "the conversation as external",
    scopes: "channels:read, groups:read, im:read, and mpim:read",
    request: input.request,
  });
}

function classifyGuest(input: {
  readonly userId: string;
  readonly installationTeamId: string | undefined;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): Promise<SlackClassification> {
  return classify({
    cache: guestVerdicts,
    key: `${input.installationTeamId ?? ""}:${input.userId}`,
    operation: "users.info",
    body: { user: input.userId },
    field: "user",
    read: (user) =>
      typeof user.is_restricted === "boolean"
        ? user.is_restricted || user.is_ultra_restricted === true
        : undefined,
    treats: "the user as a guest",
    scopes: "users:read",
    request: input.request,
  });
}

/**
 * Memoized conversation classification for one request. An Events API
 * callback's `is_ext_shared_channel` answers without a lookup when it is
 * `true`, even for events that name no conversation.
 */
export function slackConversationClassifier(input: {
  readonly channelId: string | undefined;
  readonly installationTeamId: string | undefined;
  /** `is_ext_shared_channel` from an Events API callback, when there is one. */
  readonly extSharedChannel?: boolean;
  readonly request: (operation: string, body: unknown) => Promise<SlackApiResponse>;
}): () => Promise<SlackClassification> {
  let verdict: Promise<SlackClassification> | undefined;
  return () => (verdict ??= classifyEventConversation(input));
}

async function classifyEventConversation(
  input: Parameters<typeof slackConversationClassifier>[0],
): Promise<SlackClassification> {
  const { channelId } = input;
  if (input.extSharedChannel === true) {
    if (channelId !== undefined) {
      conversationVerdicts.set(
        `${input.installationTeamId ?? ""}:${channelId}`,
        { flagged: true },
        false,
      );
    }
    return { flagged: true };
  }
  if (channelId === undefined) return { flagged: false };
  // The envelope flag doesn't report a pending share, so a `false` is used for this event but never
  // cached: a later answer or command must still get the lookup that sees one.
  if (input.extSharedChannel === false) return { flagged: false };
  return await classifyConversation({ ...input, channelId });
}

const missingScopes = new WeakMap<SlackInboundRequest, Set<string>>();

/** Scopes a lookup behind this request found missing. */
export function slackInboundMissingScopes(request: SlackInboundRequest): readonly string[] {
  return [...(missingScopes.get(request) ?? [])];
}

/** Builds the request `allowFrom` sees. */
export function createSlackInboundRequest(input: {
  readonly kind: SlackInboundKind;
  readonly channelId: string | undefined;
  readonly installationTeamId: string | undefined;
  readonly user: SlackInboundUser | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly slack: SlackWorkspaceHandle;
  /** Shares a classifier the hook context also exposes; built from `slack` otherwise. */
  readonly classifyConversation?: () => Promise<SlackClassification>;
}): SlackInboundRequest {
  const { user } = input;
  const scopes = new Set<string>();
  const conversation =
    input.classifyConversation ??
    slackConversationClassifier({
      channelId: input.channelId,
      installationTeamId: input.installationTeamId,
      request: input.slack.request,
    });
  let guest: Promise<SlackClassification> | undefined;
  const flagged = async (verdict: Promise<SlackClassification>) => {
    const { flagged, missingScope } = await verdict;
    if (missingScope !== undefined) scopes.add(missingScope);
    return flagged;
  };
  const request: SlackInboundRequest = {
    kind: input.kind,
    channelId: input.channelId,
    installationTeamId: input.installationTeamId,
    user,
    isExternalConversation: () => flagged(conversation()),
    isGuest: () =>
      flagged(
        (guest ??=
          user === undefined
            ? Promise.resolve({ flagged: false })
            : classifyGuest({
                userId: user.id,
                installationTeamId: input.installationTeamId,
                request: input.slack.request,
              })),
      ),
    raw: input.raw,
    slack: input.slack,
  };
  missingScopes.set(request, scopes);
  return request;
}

/**
 * Runs `allowFrom`, treating a throw as a refusal. Logs refusals without content.
 * When a lookup failed for a missing scope, tells the person who asked, so an
 * upgraded app that needs a reinstall doesn't fail silently.
 */
export async function isSlackRequestAllowed(
  allowFrom: SlackAllowFrom | undefined,
  request: SlackInboundRequest,
): Promise<boolean> {
  let allowed = false;
  try {
    allowed = await decide(allowFrom, request);
  } catch (error) {
    logError(log, "Slack allowFrom failed; refusing the request", error, {
      channelId: request.channelId,
      kind: request.kind,
    });
    return false;
  }
  if (!allowed) {
    log.info("Slack request not allowed", { channelId: request.channelId, kind: request.kind });
    await noticeMissingScopes(request);
  }
  return allowed;
}

async function noticeMissingScopes(request: SlackInboundRequest): Promise<void> {
  const scopes = slackInboundMissingScopes(request);
  const { user, channelId } = request;
  if (scopes.length === 0 || user === undefined || channelId === undefined) return;
  const thread = threadTsOf(request.raw);
  try {
    const response = await request.slack.request("chat.postEphemeral", {
      channel: channelId,
      user: user.id,
      ...(thread !== undefined && { thread_ts: thread }),
      text: `I can't respond yet: this Slack app is missing the ${scopes.join(", ")} scope${scopes.length === 1 ? "" : "s"}. Ask a workspace admin to add ${scopes.length === 1 ? "it" : "them"} and reinstall the app.`,
    });
    if (response.ok !== true) {
      log.warn("Slack missing-scope notice failed", { channelId, error: response.error });
    }
  } catch (error) {
    logError(log, "Slack missing-scope notice failed", error, { channelId });
  }
}

/** The thread an inbound event or interaction happened in, when it was one. */
function threadTsOf(raw: Readonly<Record<string, unknown>>): string | undefined {
  for (const source of [raw.event, raw.message]) {
    if (typeof source === "object" && source !== null) {
      const threadTs = (source as { readonly thread_ts?: unknown }).thread_ts;
      if (typeof threadTs === "string" && threadTs.length > 0) return threadTs;
    }
  }
  return undefined;
}

/** Checks an interactivity payload: an answer, an action, a slash command, or a shortcut. */
export async function allowSlackInteraction(input: {
  readonly allowFrom: SlackAllowFrom | undefined;
  readonly api: SlackTransportOptions | undefined;
  readonly botToken: SlackBotToken | undefined;
  readonly kind: Extract<SlackInboundKind, "answer" | "interaction" | "command" | "shortcut">;
  readonly channelId: string | undefined;
  readonly installationTeamId: string | undefined;
  readonly teamId: string | undefined;
  readonly userId: string;
  readonly raw: Readonly<Record<string, unknown>>;
}): Promise<boolean> {
  return await isSlackRequestAllowed(
    input.allowFrom,
    createSlackInboundRequest({
      kind: input.kind,
      channelId: input.channelId,
      installationTeamId: input.installationTeamId,
      user:
        input.teamId === undefined
          ? { id: input.userId }
          : { id: input.userId, teamId: input.teamId },
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
