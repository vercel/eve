/**
 * A long-running relay that holds a Discord Gateway connection and forwards
 * message dispatches to an eve agent's `discordChannel({ gateway })` route.
 * Run it in a process that stays up, such as a Vercel Daemon; it does not
 * belong in the agent itself.
 */

import { createLogger } from "#internal/logging.js";
import { type OutboundAuthFn, vercelOidc } from "#public/agents/auth.js";
import {
  resolveDiscordBotToken,
  type DiscordApiOptions,
  type DiscordBotToken,
} from "#public/channels/discord/api.js";
import {
  DiscordGatewayFatalError,
  type ResumableGatewaySession,
  runGatewayConnection,
  sleep,
} from "#public/channels/discord/gateway/connection.js";
import { createForwarder } from "#public/channels/discord/gateway/forwarder.js";
import type {
  DiscordGatewayHandoff,
  DiscordGatewaySession,
} from "#public/channels/discord/gateway/handoff.js";

export { DiscordGatewayFatalError };
export {
  type DiscordGatewayHandoff,
  type DiscordGatewaySession,
  vercelBlobHandoff,
  type VercelBlobHandoffOptions,
} from "#public/channels/discord/gateway/handoff.js";

const log = createLogger("discord.gateway");

const GUILD_MESSAGES_INTENT = 1 << 9;
const DIRECT_MESSAGES_INTENT = 1 << 12;
const MESSAGE_CONTENT_INTENT = 1 << 15;

// Vercel Daemons get 10 seconds between SIGTERM and SIGKILL by default.
const SHUTDOWN_DRAIN_MS = 8_000;
// On a deploy, the old relay saves its session as the new one boots, so give it time to land.
const HANDOFF_WAIT_MS = 10_000;
const HANDOFF_POLL_MS = 500;
// Discord expires a session a few minutes after its connection closes; resume only fresh ones.
const HANDOFF_MAX_AGE_MS = 60_000;

/** Options for {@link experimental_runDiscordGatewayRelay}. */
export interface DiscordGatewayRelayOptions {
  /**
   * Bot credentials. Pass the same object as the agent's `discordChannel`,
   * such as `connectDiscordCredentials(...)`. `botToken` falls back to
   * `DISCORD_BOT_TOKEN`.
   */
  readonly credentials?: { readonly botToken?: DiscordBotToken };
  /** Discord REST API overrides. */
  readonly api?: Omit<DiscordApiOptions, "credentials">;
  /**
   * Base URL of the eve deployment. Defaults to
   * `https://$VERCEL_PROJECT_PRODUCTION_URL`, which a Vercel Daemon has. Set it
   * to `http://localhost:<port>` to relay to `eve dev`.
   */
  readonly url?: string | URL;
  /** Path of the agent's Gateway route. Defaults to `/eve/v1/discord/gateway`. */
  readonly route?: string;
  /**
   * Headers that authenticate each forwarded dispatch. Defaults to this
   * project's Vercel OIDC token, which the route accepts by default. Without a
   * token, as on a laptop, requests go out unauthenticated, which `eve dev`
   * accepts.
   */
  readonly auth?: OutboundAuthFn;
  /**
   * Also request the privileged Message Content intent, so messages that do
   * not mention the bot, such as thread follow-ups, arrive with their text.
   * Enable it under Bot in the Discord Developer Portal first, or Discord
   * refuses the connection.
   */
  readonly messageContent?: boolean;
  /**
   * Hands the Gateway session from a stopping relay to the one that replaces
   * it, such as {@link vercelBlobHandoff}. The stopping relay keeps the session
   * resumable and saves it; the next relay waits up to 10 seconds for it,
   * resumes it, and Discord replays the messages sent in between. Without it,
   * each relay starts a new session and those messages are lost.
   */
  readonly handoff?: DiscordGatewayHandoff;
  /** Stops the relay. Defaults to the process's `SIGTERM` and `SIGINT`. */
  readonly signal?: AbortSignal;
}

/**
 * Connects to the Discord Gateway as the bot and forwards every
 * `MESSAGE_CREATE` dispatch, unchanged and in order, to the agent's
 * `discordChannel({ gateway })` route. Reconnects and resumes on its own.
 * Resolves after `signal` aborts and in-flight deliveries drain; rejects with
 * {@link DiscordGatewayFatalError} when Discord refuses the bot's token or
 * intents.
 *
 * Run exactly one relay per bot: Discord sends every message to each
 * connection, so a second relay makes the agent answer twice.
 */
export async function experimental_runDiscordGatewayRelay(
  options: DiscordGatewayRelayOptions = {},
): Promise<void> {
  const target = new URL(options.route ?? "/eve/v1/discord/gateway", resolveBaseUrl(options.url));
  const shutdown = options.signal === undefined ? listenForShutdown() : undefined;
  const signal = options.signal ?? shutdown!.signal;
  const forwarder = createForwarder({
    headers: outboundHeaders(options.auth),
    url: target,
  });

  log.info("Discord Gateway relay started", { target: target.href });
  const handoff = options.handoff;
  let session: ResumableGatewaySession | undefined;
  try {
    session = await runGatewayConnection({
      apiBaseUrl: options.api?.apiBaseUrl,
      fetch: options.api?.fetch,
      intents:
        GUILD_MESSAGES_INTENT |
        DIRECT_MESSAGES_INTENT |
        (options.messageContent === true ? MESSAGE_CONTENT_INTENT : 0),
      keepSessionOnAbort: handoff !== undefined,
      onDispatch: (dispatch) => {
        if (dispatch.t === "MESSAGE_CREATE") forwarder.enqueue(dispatch);
      },
      resolveToken: () => resolveDiscordBotToken(options.credentials?.botToken),
      resume: handoff === undefined ? undefined : await takeSession(handoff, signal),
      signal,
    });
  } finally {
    shutdown?.dispose();
    // Before draining, so the next relay can resume while this one finishes deliveries.
    if (handoff !== undefined && session !== undefined) await saveSession(handoff, session);
    await forwarder.drain(SHUTDOWN_DRAIN_MS);
  }
}

async function takeSession(
  handoff: DiscordGatewayHandoff,
  signal: AbortSignal,
): Promise<ResumableGatewaySession | undefined> {
  const deadline = Date.now() + HANDOFF_WAIT_MS;
  while (!signal.aborted) {
    let saved: DiscordGatewaySession | undefined;
    try {
      saved = await handoff.take();
    } catch (error) {
      log.warn("Discord Gateway handoff could not be read; starting a new session", { error });
      return undefined;
    }
    if (saved !== undefined && Date.now() - saved.savedAt <= HANDOFF_MAX_AGE_MS) {
      log.info("Resuming the Discord Gateway session a previous relay left", {
        sessionId: saved.sessionId,
      });
      return { resumeUrl: saved.resumeUrl, sequence: saved.sequence, sessionId: saved.sessionId };
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(HANDOFF_POLL_MS, signal);
  }
  return undefined;
}

async function saveSession(
  handoff: DiscordGatewayHandoff,
  session: ResumableGatewaySession,
): Promise<void> {
  try {
    await handoff.put({ ...session, savedAt: Date.now() });
  } catch (error) {
    log.warn("Discord Gateway session could not be saved for the next relay", { error });
  }
}

function resolveBaseUrl(url: string | URL | undefined): URL {
  if (url !== undefined) return new URL(url);
  const production = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (production) return new URL(`https://${production}`);
  throw new Error(
    "experimental_runDiscordGatewayRelay needs the eve deployment's URL: pass `url`, such as " +
      "http://localhost:2000 for eve dev, or run it where VERCEL_PROJECT_PRODUCTION_URL is set.",
  );
}

function outboundHeaders(
  auth: OutboundAuthFn | undefined,
): () => Promise<Readonly<Record<string, string>>> {
  if (auth !== undefined) return async () => (await auth()).headers;
  const oidc = vercelOidc();
  let warned = false;
  return async () => {
    try {
      return (await oidc()).headers;
    } catch (error) {
      if (!warned) {
        warned = true;
        log.warn("No Vercel OIDC token; forwarding without credentials", { error });
      }
      return {};
    }
  };
}

function listenForShutdown(): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const signals = ["SIGTERM", "SIGINT"] as const;
  const onSignal = (name: NodeJS.Signals) => {
    log.info("Discord Gateway relay shutting down", { signal: name });
    controller.abort();
  };
  for (const name of signals) process.once(name, onSignal);
  return {
    signal: controller.signal,
    dispose: () => {
      for (const name of signals) process.off(name, onSignal);
    },
  };
}
