import { createLogger } from "#internal/logging.js";
import type { DiscordGatewayDispatch } from "#public/channels/discord/gateway/connection.js";
import { sleep } from "#public/channels/discord/gateway/connection.js";

const log = createLogger("discord.gateway");

const MAX_PENDING = 500;
const MAX_ATTEMPTS = 5;
// Generous so a cold start answers before the relay gives up; a timed-out request is not retried.
const REQUEST_TIMEOUT_MS = 30_000;
// Only a rate limit proves eve turned the request away; a 5xx can come after a turn started.
const RATE_LIMITED = 429;
// Failures that happen before the request reaches eve, so retrying cannot start a second turn.
const UNSENT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export interface Forwarder {
  enqueue(dispatch: DiscordGatewayDispatch): void;
  /** Resolves once the backlog is delivered or `timeoutMs` elapses. */
  drain(timeoutMs: number): Promise<void>;
}

/**
 * Delivers dispatches to eve one at a time, in Gateway order. A bounded
 * backlog keeps a long eve outage from growing the relay's memory without limit.
 */
export function createForwarder(options: {
  readonly url: URL;
  readonly headers: () => Promise<Readonly<Record<string, string>>>;
}): Forwarder {
  let tail = Promise.resolve();
  let pending = 0;

  return {
    enqueue(dispatch) {
      if (pending >= MAX_PENDING) {
        log.error("Discord Gateway backlog is full; dropped a dispatch", {
          event: dispatch.t,
          sequence: dispatch.s,
        });
        return;
      }
      pending += 1;
      tail = tail
        .then(() => deliver(dispatch))
        .finally(() => {
          pending -= 1;
        });
    },
    async drain(timeoutMs) {
      if (pending > 0) {
        const timeout = new AbortController();
        await Promise.race([tail, sleep(timeoutMs, timeout.signal)]);
        timeout.abort();
      }
      if (pending > 0)
        log.warn("Discord Gateway relay stopped with undelivered dispatches", { pending });
    },
  };

  async function deliver(dispatch: DiscordGatewayDispatch): Promise<void> {
    const body = JSON.stringify(dispatch);
    const fields = { event: dispatch.t, sequence: dispatch.s };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(options.url, {
          body,
          headers: { "content-type": "application/json", ...(await options.headers()) },
          method: "POST",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return;

        const detail = (await response.text()).slice(0, 200);
        if (response.status >= 500) {
          // A gateway timeout or crash after dispatch would answer the message twice on retry.
          log.error("Gave up forwarding a Discord dispatch that eve may have received", {
            ...fields,
            detail,
            status: response.status,
          });
          return;
        }
        if (response.status !== RATE_LIMITED) {
          log.error("eve rejected a forwarded Discord dispatch", {
            ...fields,
            detail,
            hint:
              response.status === 401 || response.status === 403
                ? "eve did not accept the relay's credentials. On Vercel, check that the relay runs in the same project as the agent."
                : `Check that ${options.url.href} is the agent's discordChannel({ gateway }) route.`,
            status: response.status,
          });
          return;
        }
        log.warn("Retrying a forwarded Discord dispatch", {
          ...fields,
          attempt,
          detail,
          status: response.status,
        });
      } catch (error) {
        if (!UNSENT_ERROR_CODES.has(errorCode(error))) {
          // eve may have started the turn already; a retry could answer twice.
          log.error("Gave up forwarding a Discord dispatch that eve may have received", {
            ...fields,
            error,
          });
          return;
        }
        log.warn("Retrying a forwarded Discord dispatch", { ...fields, attempt, error });
      }
      if (attempt < MAX_ATTEMPTS) await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    }
    log.error("Gave up forwarding a Discord dispatch", { ...fields, attempts: MAX_ATTEMPTS });
  }
}

function errorCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "";
}
