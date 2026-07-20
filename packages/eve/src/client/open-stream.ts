import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createEveMessageStreamRoutePath } from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
import type { ClientRedirectPolicy } from "#client/types.js";
import { createClientUrl } from "#client/url.js";

const STREAM_OPEN_RETRY_ATTEMPTS = 12;
const STREAM_OPEN_RETRY_BASE_DELAY_MS = 250;
const STREAM_OPEN_RETRY_MAX_DELAY_MS = 5_000;
const STREAM_OPEN_RETRYABLE_STATUS = new Set([404, 409, 425, 500, 502, 503, 504]);

const STREAM_RECONNECT_BASE_DELAY_MS = 250;
const STREAM_RECONNECT_MAX_DELAY_MS = 4_000;
const STREAM_MAX_IDLE_RECONNECTS = 5;

/**
 * Internal configuration for following a durable event stream.
 */
interface FollowStreamInput {
  readonly host: string;
  readonly resolveHeaders: () => Promise<Headers>;
  readonly redirect?: ClientRedirectPolicy;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly startIndex: number;
}

/**
 * Follows a session's durable event stream from an absolute cursor,
 * transparently reconnecting whenever the transport ends.
 *
 * Transport endings reconnect from the advanced cursor. Progress resets the
 * idle budget; repeated empty streams eventually stop the follow. Callers own
 * boundary handling. Negative tail-relative cursors use one connection because
 * they cannot be advanced safely.
 */
export async function* followStreamIterable(
  input: FollowStreamInput,
): AsyncGenerator<HandleMessageStreamEvent> {
  let startIndex = input.startIndex;
  let reconnectDelayMs = STREAM_RECONNECT_BASE_DELAY_MS;
  let idleReconnects = 0;
  let initialConnection = true;

  while (true) {
    let body: ReadableStream<Uint8Array>;
    try {
      body = await openStreamBody({ ...input, startIndex });
    } catch (error) {
      if (input.signal?.aborted) {
        return;
      }
      throw error;
    }

    let deliveredEvent = false;
    try {
      for await (const event of readNdjsonStream(body)) {
        startIndex += 1;
        deliveredEvent = true;
        reconnectDelayMs = STREAM_RECONNECT_BASE_DELAY_MS;
        idleReconnects = 0;
        yield event;
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) {
        throw error;
      }
    }

    if (input.signal?.aborted || input.startIndex < 0) {
      return;
    }

    if (
      !deliveredEvent &&
      !initialConnection &&
      (idleReconnects += 1) >= STREAM_MAX_IDLE_RECONNECTS
    ) {
      return;
    }

    initialConnection = false;
    await sleep(reconnectDelayMs, input.signal);
    if (input.signal?.aborted) {
      return;
    }
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, STREAM_RECONNECT_MAX_DELAY_MS);
  }
}

/**
 * Opens one stream response body, retrying transient failures with capped
 * exponential backoff (~35s total): brief network outages and the short
 * propagation window where a just-acknowledged session may not yet be
 * readable from the stream route.
 */
export async function openStreamBody(
  input: FollowStreamInput,
): Promise<ReadableStream<Uint8Array>> {
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;
  let retryDelayMs = STREAM_OPEN_RETRY_BASE_DELAY_MS;

  for (let attempt = 0; attempt < STREAM_OPEN_RETRY_ATTEMPTS; attempt += 1) {
    const url = createClientUrl(
      input.host,
      createEveMessageStreamRoutePath(input.sessionId),
      input.startIndex !== 0 ? { startIndex: String(input.startIndex) } : undefined,
    );

    const headers = await input.resolveHeaders();
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        redirect: input.redirect,
        signal: input.signal ?? null,
      });
    } catch (error) {
      if (
        input.signal?.aborted ||
        !isStreamDisconnectError(error) ||
        attempt === STREAM_OPEN_RETRY_ATTEMPTS - 1
      ) {
        throw error;
      }
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, STREAM_OPEN_RETRY_MAX_DELAY_MS);
      continue;
    }

    if (response.ok) {
      if (!response.body) {
        throw new ClientError(response.status, "Response body is null.", response.headers);
      }
      return response.body;
    }

    lastStatus = response.status;
    lastBody = await response.text();
    lastHeaders = response.headers;

    if (!STREAM_OPEN_RETRYABLE_STATUS.has(response.status)) {
      throw new ClientError(response.status, lastBody, response.headers);
    }

    if (attempt < STREAM_OPEN_RETRY_ATTEMPTS - 1) {
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, STREAM_OPEN_RETRY_MAX_DELAY_MS);
    }
  }

  throw new ClientError(lastStatus ?? 0, lastBody ?? "Failed to open message stream.", lastHeaders);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
