/**
 * Slack Web API transport: bot-token resolution and the fetch every
 * outbound call travels on, resolved once and carried as one value.
 *
 * Separate from `api.ts` to keep that file under the 700-line cap
 * `internal/structural-tests/file-length.test.ts` enforces.
 */

import {
  resolveSlackBotToken as resolveSlackBotTokenPrimitive,
  type SlackApiOptions as SlackPrimitiveApiOptions,
  type SlackApiResponse as SlackPrimitiveApiResponse,
} from "#compiled/@chat-adapter/slack/api.js";

import { callSlackApiTrackingResponse } from "#public/channels/slack/api-errors.js";

/** Slack app installation workspace available when eve resolves a bot token. */
export interface SlackBotTokenContext {
  readonly teamId?: string;
}

/**
 * Slack bot token, materialized either as a literal `xoxb-...` string or
 * as a (possibly async) function that receives the app installation workspace.
 */
export type SlackBotToken = string | ((context: SlackBotTokenContext) => string | Promise<string>);

/**
 * Materializes a {@link SlackBotToken} to a string, falling back to
 * `process.env.SLACK_BOT_TOKEN`. Throws when neither is set.
 */
export async function resolveSlackBotToken(
  token?: SlackBotToken,
  context: SlackBotTokenContext = {},
): Promise<string> {
  const source = token ?? process.env.SLACK_BOT_TOKEN;
  if (!source) throw new Error("SLACK_BOT_TOKEN is required.");
  if (typeof source === "function") return source(context);
  return resolveSlackBotTokenPrimitive(source);
}

/**
 * Slack Web API JSON response envelope. `ok` signals success, `error`
 * carries Slack's error code on failure, and method-specific fields pass
 * through verbatim. Callers inspect `ok` themselves.
 */
export type SlackApiResponse = SlackPrimitiveApiResponse;

/**
 * A Slack Web API caller bound to a transport, with the app installation
 * workspace supplied per call.
 */
export type SlackApiCaller = (
  operation: string,
  body: unknown,
  context?: SlackBotTokenContext,
) => Promise<SlackApiResponse>;

/**
 * The channel's Slack Web API transport: a bot token and the fetch its
 * traffic travels on, resolved once and carried as one opaque value.
 *
 * Every builder that outlives a request takes one of these rather than a
 * bare `botToken`. There is then one construction site per channel, so a
 * builder cannot be handed credentials the rest of the channel is not
 * using, and a later transport concern needs no new parameter threaded
 * through each of them.
 */
export interface SlackTransport {
  /** POSTs to a Slack Web API method through this transport. */
  readonly call: SlackApiCaller;

  /**
   * Transport options for the vendored Slack helpers, scoped to one
   * installation workspace.
   */
  options(context?: SlackBotTokenContext): SlackPrimitiveApiOptions;

  /** Materializes the bot token for one installation workspace. */
  resolveToken(context?: SlackBotTokenContext): Promise<string>;

  /**
   * Materializes the bot token up front and returns a caller bound to
   * it, so a throwing token resolver surfaces at the bind rather than
   * from inside the call.
   */
  bindToken(
    context?: SlackBotTokenContext,
  ): Promise<(operation: string, body: unknown) => Promise<SlackApiResponse>>;
}

/** Builds the {@link SlackTransport} a channel funnels every call through. */
export function createSlackTransport(input: { readonly botToken?: SlackBotToken }): SlackTransport {
  const options = (context: SlackBotTokenContext = {}): SlackPrimitiveApiOptions => ({
    token: () => resolveSlackBotToken(input.botToken, context),
  });

  return {
    call: (operation, body, context) =>
      callSlackApiTrackingResponse(operation, normalizeSlackApiBody(body), options(context)),
    options,
    resolveToken: (context = {}) => resolveSlackBotToken(input.botToken, context),
    async bindToken(context = {}) {
      const token = await resolveSlackBotToken(input.botToken, context);
      return (operation, body) =>
        callSlackApiTrackingResponse(operation, normalizeSlackApiBody(body), {
          ...options(),
          token,
        });
    },
  };
}

/**
 * Low-level POST to a Slack Web API method, signed with the bot token
 * and form-encoded. Form is the only safe default: Slack's JSON support
 * is partial (e.g. `conversations.replies` rejects JSON). Returns the
 * raw JSON response; callers inspect `response.ok` themselves.
 *
 * The escape hatch for code holding a bare token rather than a channel.
 */
export async function callSlackApi(input: {
  readonly botToken: SlackBotToken | undefined;
  readonly context?: SlackBotTokenContext;
  readonly operation: string;
  readonly body: unknown;
}): Promise<SlackApiResponse> {
  const transport = createSlackTransport({ botToken: input.botToken });
  return transport.call(input.operation, input.body, input.context);
}

function normalizeSlackApiBody(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}
