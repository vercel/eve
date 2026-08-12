/**
 * Bot-token resolution seam for the Slack channel.
 *
 * Owns the public {@link SlackBotToken} / {@link SlackBotTokenContext}
 * shapes and the low-level {@link callSlackApi} helper so that `api.ts`
 * (the thread/handle surface) stays under the file-length cap and the
 * identity→token wiring lives in exactly one place.
 */

import {
  callSlackApi as callSlackApiPrimitive,
  resolveSlackBotToken as resolveSlackBotTokenPrimitive,
  type SlackApiOptions,
  type SlackApiResponse,
  type SlackBotToken as SlackPrimitiveBotToken,
} from "#compiled/@chat-adapter/slack/api.js";

/**
 * Slack workspace / thread identity passed to context-aware
 * {@link SlackBotToken} callbacks. A single Slack app installed into
 * multiple workspaces receives events carrying each workspace's `team_id`;
 * a context-aware token callback uses these fields to select the correct
 * installation's bot token (e.g. via a Connect multi-install connector or
 * a workspace→token map) instead of a single workspace-agnostic token.
 *
 * All fields are optional because not every call site knows the full
 * identity: threadless proactive posts have no `threadTs` yet, and some
 * inbound events omit `team_id`. A zero-argument token callback never
 * receives a context and keeps working unchanged.
 */
export interface SlackBotTokenContext {
  /** Slack workspace id (`T…`) carried by the inbound event, when present. */
  readonly teamId?: string;
  /** Slack channel id being posted to, when known. */
  readonly channelId?: string;
  /** Slack thread root ts being posted into, when known. */
  readonly threadTs?: string;
}

/**
 * Slack bot token, materialized either as a literal `xoxb-...` string or
 * as a (possibly async) function that returns one.
 *
 * The zero-argument form supports secret-manager lookups and credential
 * rotation. The context-arg form additionally receives the current Slack
 * workspace/thread identity ({@link SlackBotTokenContext}) so a single
 * channel can resolve a per-workspace token for a multi-install Slack
 * connector. Both function shapes remain valid; existing zero-arg
 * callbacks are unaffected.
 */
export type SlackBotToken =
  | string
  | (() => string | Promise<string>)
  | ((context: SlackBotTokenContext) => string | Promise<string>);

/**
 * Materializes a {@link SlackBotToken} to a string, falling back to
 * `process.env.SLACK_BOT_TOKEN`. Throws when neither is set.
 *
 * `context` carries the current Slack workspace/thread identity
 * ({@link SlackBotTokenContext}). It is only forwarded to context-aware
 * (arity > 0) token callbacks; zero-arg callbacks never receive it, so a
 * literal string or a `() => token` callback behaves exactly as before.
 */
export async function resolveSlackBotToken(
  token?: SlackBotToken,
  context?: SlackBotTokenContext,
): Promise<string> {
  const source = token ?? process.env.SLACK_BOT_TOKEN;
  if (!source) throw new Error("SLACK_BOT_TOKEN is required.");
  if (typeof source === "function" && source.length > 0) {
    return (source as (ctx: SlackBotTokenContext) => string | Promise<string>)(context ?? {});
  }
  return resolveSlackBotTokenPrimitive(source as SlackPrimitiveBotToken);
}

/**
 * Low-level POST to a Slack Web API method, signed with the bot token
 * and form-encoded. Form is the only safe default: Slack's JSON support
 * is partial (e.g. `conversations.replies` rejects JSON). Returns the
 * raw JSON response; callers inspect `response.ok` themselves.
 */
export async function callSlackApi(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly operation: string;
  readonly body: unknown;
  /** Slack workspace/thread identity forwarded to context-aware token callbacks. */
  readonly context?: SlackBotTokenContext;
}): Promise<SlackApiResponse> {
  return callSlackApiPrimitive(
    input.operation,
    normalizeSlackApiBody(input.body),
    createSlackApiOptions(input.botToken, input.context),
  );
}

/**
 * Builds the `request(op, body)` Slack API caller installed on every
 * `SlackHandle`. `context` is a getter so the resolved identity is always
 * current (the thread auto-anchors on the first post for threadless
 * sessions, mutating the live `threadTs`).
 */
export function createSlackRequester(
  botToken: SlackBotToken | undefined,
  context?: () => SlackBotTokenContext,
): (operation: string, body: unknown) => Promise<SlackApiResponse> {
  return (operation, body) => callSlackApi({ botToken, operation, body, context: context?.() });
}

/** Wraps token resolution in the primitive's options envelope. */
export function createSlackApiOptions(
  botToken: SlackBotToken | undefined,
  context?: SlackBotTokenContext,
): SlackApiOptions {
  return { token: () => resolveSlackBotToken(botToken, context) };
}

function normalizeSlackApiBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}
