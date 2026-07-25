import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/message.js";
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
  readonly endAtTail?: boolean;
}

/**
 * Configuration for one connection open. `requestTailIndex` asks the server
 * to report the durable tail index on the response; connections that do not
 * need the bound skip the lookup it costs server-side.
 */
interface OpenStreamInput extends FollowStreamInput {
  readonly requestTailIndex?: boolean;
}

/**
 * Follows a session's durable event stream from an absolute cursor,
 * transparently reconnecting whenever the transport ends.
 *
 * Transport endings reconnect from the advanced cursor. Progress resets the
 * idle budget; repeated empty streams eventually stop the follow. Callers own
 * boundary handling. Negative tail-relative cursors use one connection because
 * they cannot be advanced safely.
 *
 * With `endAtTail`, the first connection's `x-eve-stream-tail-index` header
 * fixes the bound: the iterator yields events until the cursor passes that
 * tail, reconnecting as needed, then returns instead of following.
 */
export async function* followStreamIterable(
  input: FollowStreamInput,
): AsyncGenerator<HandleMessageStreamEvent> {
  if (input.endAtTail === true && input.startIndex < 0) {
    throw new Error(
      "endAtTail requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
    );
  }

  let startIndex = input.startIndex;
  let reconnectDelayMs = STREAM_RECONNECT_BASE_DELAY_MS;
  let idleReconnects = 0;
  let initialConnection = true;
  let tailIndex: number | undefined;

  while (true) {
    let connection: OpenedStream;
    try {
      connection = await openStreamBody({
        ...input,
        startIndex,
        requestTailIndex: input.endAtTail === true && tailIndex === undefined,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        return;
      }
      throw error;
    }

    if (input.endAtTail === true && tailIndex === undefined) {
      tailIndex = connection.tailIndex;
      if (tailIndex === undefined) {
        await connection.body.cancel().catch(() => {});
        throw new Error(
          `endAtTail requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. ` +
            "The agent may be running an older eve version.",
        );
      }
    }

    if (tailIndex !== undefined && startIndex > tailIndex) {
      await connection.body.cancel().catch(() => {});
      return;
    }

    let deliveredEvent = false;
    try {
      for await (const event of readNdjsonStream(connection.body)) {
        startIndex += 1;
        deliveredEvent = true;
        reconnectDelayMs = STREAM_RECONNECT_BASE_DELAY_MS;
        idleReconnects = 0;
        yield event;

        if (tailIndex !== undefined && startIndex > tailIndex) {
          return;
        }
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
 * One opened stream connection: the response body plus the durable tail
 * index reported by the `x-eve-stream-tail-index` response header, when
 * present and well-formed.
 */
interface OpenedStream {
  readonly body: ReadableStream<Uint8Array>;
  readonly tailIndex: number | undefined;
}

/**
 * Opens one stream response body, retrying transient failures with capped
 * exponential backoff (~35s total): brief network outages and the short
 * propagation window where a just-acknowledged session may not yet be
 * readable from the stream route.
 */
export async function openStreamBody(input: OpenStreamInput): Promise<OpenedStream> {
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;
  let retryDelayMs = STREAM_OPEN_RETRY_BASE_DELAY_MS;

  const searchParams = {
    ...(input.startIndex !== 0 ? { startIndex: String(input.startIndex) } : {}),
    ...(input.requestTailIndex === true ? { includeTailIndex: "1" } : {}),
  };

  for (let attempt = 0; attempt < STREAM_OPEN_RETRY_ATTEMPTS; attempt += 1) {
    const url = createClientUrl(
      input.host,
      createEveMessageStreamRoutePath(input.sessionId),
      Object.keys(searchParams).length > 0 ? searchParams : undefined,
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
      return { body: response.body, tailIndex: parseTailIndexHeader(response.headers) };
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

function parseTailIndexHeader(headers: Headers): number | undefined {
  const raw = headers.get(EVE_STREAM_TAIL_INDEX_HEADER);
  if (raw === null || !/^-?\d+$/.test(raw)) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
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
