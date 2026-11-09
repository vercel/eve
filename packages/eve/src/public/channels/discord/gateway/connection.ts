import { createLogger } from "#internal/logging.js";
import { callDiscordApi, type DiscordFetch } from "#public/channels/discord/api.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";

const log = createLogger("discord.gateway");

const MAX_RECONNECT_DELAY_MS = 60_000;
// Discord ends the session on 1000 and 1001; any 4xxx close we send keeps it resumable.
const RESUMABLE_CLOSE = 4000;
// Bad token, bad shard, sharding required, bad API version, bad or disallowed intents.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// A dead peer never answers a close frame, so the socket would sit in CLOSING.
const CLOSE_HANDSHAKE_TIMEOUT_MS = 3_000;
// Invalid sequence and session timed out: reconnect, but identify from scratch.
const SESSION_RESET_CLOSE_CODES = new Set([4007, 4009]);

/** Raised when Discord refuses the bot outright, so reconnecting cannot help. */
export class DiscordGatewayFatalError extends Error {}

/** A Gateway dispatch (op 0) as Discord sends it. */
export interface DiscordGatewayDispatch {
  readonly op: 0;
  readonly t: string;
  readonly s: number;
  readonly d: unknown;
}

export interface GatewayConnectionOptions {
  readonly apiBaseUrl?: string;
  readonly fetch?: DiscordFetch;
  readonly intents: number;
  readonly resolveToken: () => Promise<string>;
  readonly onDispatch: (dispatch: DiscordGatewayDispatch) => void;
  readonly signal: AbortSignal;
}

interface GatewayPayload {
  readonly op: number;
  readonly d: unknown;
  readonly s?: number | null;
  readonly t?: string | null;
}

interface GatewaySession {
  readonly id: string;
  readonly resumeUrl: string;
}

type GatewayUrlResult = { readonly url: string } | { readonly fatal: string };

/**
 * Holds one Discord Gateway session until `signal` aborts, resuming across
 * reconnects so dispatches are not lost while the process lives.
 */
export async function runGatewayConnection(options: GatewayConnectionOptions): Promise<void> {
  let session: GatewaySession | undefined;
  let sequence: number | null = null;
  let failures = 0;
  let nextDelayMs: number | undefined;

  while (!options.signal.aborted) {
    let token: string;
    let url: string;
    try {
      token = await options.resolveToken();
      if (session !== undefined) {
        url = session.resumeUrl;
      } else {
        const result = await discoverGatewayUrl(token);
        if ("fatal" in result) throw new DiscordGatewayFatalError(result.fatal);
        url = result.url;
      }
    } catch (error) {
      if (error instanceof DiscordGatewayFatalError) throw error;
      log.warn("Discord Gateway connect failed", { error });
      await sleep(backoff(failures++), options.signal);
      continue;
    }

    if (options.signal.aborted) return;
    const closed = await connect(url, token);
    if (options.signal.aborted) return;

    if (FATAL_CLOSE_CODES.has(closed.code)) {
      throw new DiscordGatewayFatalError(
        `Discord closed the Gateway with ${closed.code} (${closed.reason}). Check the bot ` +
          "token and that every requested intent is enabled under Bot in the Discord Developer Portal.",
      );
    }
    if (SESSION_RESET_CLOSE_CODES.has(closed.code)) {
      session = undefined;
      sequence = null;
    }

    const delayMs = nextDelayMs ?? backoff(failures++);
    nextDelayMs = undefined;
    log.warn("Discord Gateway closed", {
      code: closed.code,
      reason: closed.reason,
      retryInMs: Math.round(delayMs),
    });
    await sleep(delayMs, options.signal);
  }

  async function discoverGatewayUrl(token: string): Promise<GatewayUrlResult> {
    const response = await callDiscordApi({
      apiBaseUrl: options.apiBaseUrl,
      botToken: token,
      fetch: options.fetch,
      method: "GET",
      path: "/gateway/bot",
    });
    if (response.status === 401) {
      return { fatal: "Discord rejected the bot token while looking up the Gateway URL." };
    }
    if (!response.ok || !isObject(response.body) || !isNonEmptyString(response.body.url)) {
      throw new Error(`Discord Gateway URL lookup failed with HTTP ${response.status}.`);
    }
    return { url: response.body.url };
  }

  function connect(baseUrl: string, token: string): Promise<{ code: number; reason: string }> {
    return new Promise((resolve) => {
      const url = new URL(baseUrl);
      url.searchParams.set("v", "10");
      url.searchParams.set("encoding", "json");

      const socket = new WebSocket(url);
      let heartbeatTimer: NodeJS.Timeout | undefined;
      let closeTimer: NodeJS.Timeout | undefined;
      let heartbeatAcked = true;
      let settled = false;

      const settle = (code: number, reason: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(heartbeatTimer);
        clearTimeout(closeTimer);
        options.signal.removeEventListener("abort", onAbort);
        resolve({ code, reason });
      };

      const send = (payload: { op: number; d: unknown }) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      };
      const close = (code: number, reason: string) => {
        if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
          return;
        }
        socket.close(code, reason);
        closeTimer = setTimeout(() => settle(code, reason), CLOSE_HANDSHAKE_TIMEOUT_MS);
      };
      const onAbort = () => close(1000, "shutdown");
      options.signal.addEventListener("abort", onAbort, { once: true });

      const heartbeat = (intervalMs: number) => {
        if (!heartbeatAcked) {
          close(RESUMABLE_CLOSE, "heartbeat not acknowledged");
          return;
        }
        heartbeatAcked = false;
        send({ op: 1, d: sequence });
        heartbeatTimer = setTimeout(() => heartbeat(intervalMs), intervalMs);
      };

      const identifyOrResume = () => {
        if (session !== undefined && sequence !== null) {
          send({ op: 6, d: { seq: sequence, session_id: session.id, token } });
          return;
        }
        send({
          op: 2,
          d: {
            intents: options.intents,
            properties: { browser: "eve", device: "eve", os: process.platform },
            token,
          },
        });
      };

      socket.addEventListener("message", (event) => {
        if (settled) return;
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(String(event.data)) as GatewayPayload;
        } catch {
          log.warn("Discord Gateway sent a payload that is not JSON");
          return;
        }
        if (typeof payload.s === "number") sequence = payload.s;

        switch (payload.op) {
          case 0:
            onDispatch(payload);
            return;
          case 1:
            send({ op: 1, d: sequence });
            return;
          case 7:
            nextDelayMs = 0;
            close(RESUMABLE_CLOSE, "reconnect requested");
            return;
          case 9:
            if (payload.d !== true) {
              session = undefined;
              sequence = null;
            }
            nextDelayMs = 1_000 + Math.random() * 4_000;
            close(RESUMABLE_CLOSE, "invalid session");
            return;
          case 10: {
            const intervalMs = Number(
              isObject(payload.d) ? payload.d.heartbeat_interval : undefined,
            );
            heartbeatTimer = setTimeout(() => heartbeat(intervalMs), intervalMs * Math.random());
            identifyOrResume();
            return;
          }
          case 11:
            heartbeatAcked = true;
            return;
        }
      });

      socket.addEventListener("close", (event) => settle(event.code, event.reason));
    });
  }

  function onDispatch(payload: GatewayPayload): void {
    if (payload.t === "READY") {
      const ready = isObject(payload.d) ? payload.d : {};
      if (isNonEmptyString(ready.session_id) && isNonEmptyString(ready.resume_gateway_url)) {
        session = { id: ready.session_id, resumeUrl: ready.resume_gateway_url };
      }
      failures = 0;
      log.info("Discord Gateway ready", { sessionId: session?.id });
      return;
    }
    if (payload.t === "RESUMED") {
      failures = 0;
      log.info("Discord Gateway resumed", { sequence });
      return;
    }
    if (typeof payload.t === "string" && typeof payload.s === "number") {
      options.onDispatch({ d: payload.d, op: 0, s: payload.s, t: payload.t });
    }
  }
}

function backoff(failures: number): number {
  return Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** failures) * (0.5 + Math.random() / 2);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}
