import type { MessageStreamEvent } from "#protocol/message.js";
import {
  EVE_STREAM_DEFERRED_TAIL_INDEX,
  EVE_STREAM_ERROR_CONTROL,
  EVE_STREAM_TAIL_INDEX_CONTROL,
  EVE_STREAM_TAIL_INDEX_HEADER,
} from "#protocol/message.js";
import type { MessageStreamVersion } from "#protocol/message-version.js";
import { createEveSessionStreamRoutePath } from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { isStreamDisconnectError, readNdjsonStream, readWithIdleTimeout } from "#client/ndjson.js";
import { readMessageStreamVersion } from "#client/stream-version.js";
import type {
  ClientRedirectPolicy,
  ResolvedStreamReconnectPolicy as StreamReconnectPolicyOptions,
  StreamReconnectPolicy,
  StreamReconnectRetryPolicy,
} from "#client/types.js";
import { createClientUrl } from "#client/url.js";

interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
}

interface ResolvedStreamReconnectPolicy {
  readonly retryableErrorStatuses: ReadonlySet<number>;
  readonly streamIdleReconnectPolicy: RetryPolicy;
  readonly streamOpenReconnectPolicy: RetryPolicy;
}

const DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS = 15_000;
const MAX_DEFERRED_TAIL_TRANSPORT_RETRIES = 1;

const DEFAULT_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  retryableErrorStatuses: new Set([404, 409, 425, 500, 502, 503, 504]),
  streamIdleReconnectPolicy: { baseDelayMs: 250, maxAttempts: 5, maxDelayMs: 4_000 },
  streamOpenReconnectPolicy: { baseDelayMs: 250, maxAttempts: 12, maxDelayMs: 5_000 },
};

const NO_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  ...DEFAULT_STREAM_RECONNECT_POLICY,
  streamIdleReconnectPolicy: {
    ...DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy,
    maxAttempts: 0,
  },
  streamOpenReconnectPolicy: {
    ...DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy,
    maxAttempts: 1,
  },
};

function resolveRetryPolicy(
  policy: StreamReconnectRetryPolicy | undefined,
  defaults: RetryPolicy,
): RetryPolicy {
  return { ...defaults, ...policy };
}

function resolveStreamReconnectPolicy(
  policy: StreamReconnectPolicy | undefined,
): ResolvedStreamReconnectPolicy {
  if (policy && "reconnect" in policy && policy.reconnect === false) {
    return NO_STREAM_RECONNECT_POLICY;
  }

  const configured = policy as StreamReconnectPolicyOptions | undefined;
  return {
    retryableErrorStatuses: configured?.retryableErrorStatuses
      ? new Set(configured.retryableErrorStatuses)
      : DEFAULT_STREAM_RECONNECT_POLICY.retryableErrorStatuses,
    streamIdleReconnectPolicy: resolveRetryPolicy(
      configured?.streamIdleReconnectPolicy,
      DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy,
    ),
    streamOpenReconnectPolicy: resolveRetryPolicy(
      configured?.streamOpenReconnectPolicy,
      DEFAULT_STREAM_RECONNECT_POLICY.streamOpenReconnectPolicy,
    ),
  };
}

/**
 * Internal configuration for following a durable event stream.
 */
interface FollowStreamInput {
  readonly host: string;
  /** Keep reconnecting after empty streams until the consumer aborts or stops iteration. */
  readonly keepAlive?: boolean;
  readonly streamReconnectPolicy?: StreamReconnectPolicy;
  /** @internal Test override for reconnecting an open stream that stops producing bytes. */
  readonly streamReadIdleTimeoutMs?: number;
  readonly resolveHeaders: () => Promise<Headers>;
  readonly redirect?: ClientRedirectPolicy;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly startIndex: number;
  /** Follow the live stream after the durable tail (default). `false` bounds the read at the tail. */
  readonly follow?: boolean;
}

/** One connection open; `requestTailIndex` asks the server to report the durable tail index. */
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
 * With `follow: false`, the first connection fixes the bound: the iterator
 * yields events until the cursor passes that tail, reconnecting as needed,
 * then returns instead of following.
 */
export async function* followStreamIterable(
  input: FollowStreamInput,
): AsyncGenerator<MessageStreamEvent> {
  if (input.follow === false && input.startIndex < 0) {
    throw new Error(
      "stream({ follow: false }) requires a nonnegative startIndex; a tail-relative cursor cannot be bounded.",
    );
  }

  const retryPolicy = resolveStreamReconnectPolicy(input.streamReconnectPolicy);
  const idleRetryPolicy = retryPolicy.streamIdleReconnectPolicy;
  let startIndex = input.startIndex;
  let reconnectDelayMs = idleRetryPolicy.baseDelayMs;
  let idleReconnects = 0;
  let initialConnection = true;
  let tailIndex: number | undefined;

  while (true) {
    let connection: OpenedStream;
    try {
      connection = await openStreamBody({
        ...input,
        retryPolicy,
        startIndex,
        requestTailIndex: input.follow === false && tailIndex === undefined,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        return;
      }
      throw error;
    }

    if (input.follow === false && tailIndex === undefined) {
      tailIndex = connection.tailIndex;
      if (tailIndex === undefined) {
        connection.close();
        throw new Error(
          `stream({ follow: false }) requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. ` +
            "The agent may be running an older eve version.",
        );
      }
    }

    if (tailIndex !== undefined && startIndex > tailIndex) {
      connection.close();
      return;
    }

    let deliveredEvent = false;
    try {
      for await (const event of readNdjsonStream(connection.body, {
        idleTimeoutMs: input.streamReadIdleTimeoutMs ?? DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS,
        streamVersion: connection.streamVersion,
      })) {
        startIndex += 1;
        deliveredEvent = true;
        reconnectDelayMs = idleRetryPolicy.baseDelayMs;
        idleReconnects = 0;
        yield event;

        if (tailIndex !== undefined && startIndex > tailIndex) {
          return;
        }
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) throw error;
    } finally {
      connection.close();
    }

    if (input.signal?.aborted || input.startIndex < 0 || idleRetryPolicy.maxAttempts === 0) {
      return;
    }

    if (
      input.keepAlive !== true &&
      !deliveredEvent &&
      !initialConnection &&
      (idleReconnects += 1) >= idleRetryPolicy.maxAttempts
    ) {
      return;
    }

    initialConnection = false;
    await sleep(reconnectDelayMs, input.signal);
    if (input.signal?.aborted) {
      return;
    }
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, idleRetryPolicy.maxDelayMs);
  }
}

/** An opened connection: the response body plus the tail index from the response header, if any. */
interface OpenedStream {
  readonly body: ReadableStream<Uint8Array>;
  close(): void;
  readonly streamVersion: MessageStreamVersion;
  readonly tailIndex: number | undefined;
}

/**
 * Opens one stream response body, retrying transient failures with capped
 * exponential backoff (~35s total): brief network outages and the short
 * propagation window where a just-acknowledged session may not yet be
 * readable from the stream route.
 */
export async function openStreamBody(
  input: OpenStreamInput & { readonly retryPolicy?: ResolvedStreamReconnectPolicy },
): Promise<OpenedStream> {
  const retryPolicy = input.retryPolicy ?? DEFAULT_STREAM_RECONNECT_POLICY;
  const openRetryPolicy = retryPolicy.streamOpenReconnectPolicy;
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;
  let retryDelayMs = openRetryPolicy.baseDelayMs;
  let deferredTailTransportRetries = 0;

  const searchParams: Record<string, string> = {};
  if (input.startIndex !== 0) {
    searchParams.startIndex = String(input.startIndex);
  }
  if (input.requestTailIndex === true) {
    searchParams.includeTailIndex = "1";
    searchParams.deferTailIndex = "1";
  }

  for (let attempt = 0; attempt < openRetryPolicy.maxAttempts; attempt += 1) {
    const url = createClientUrl(
      input.host,
      createEveSessionStreamRoutePath(input.sessionId),
      Object.keys(searchParams).length > 0 ? searchParams : undefined,
    );

    const headers = await input.resolveHeaders();
    const connectionController = new AbortController();
    const signal = input.signal
      ? AbortSignal.any([input.signal, connectionController.signal])
      : connectionController.signal;
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        headers,
        redirect: input.redirect,
        signal,
      });
    } catch (error) {
      if (
        input.signal?.aborted ||
        !isStreamDisconnectError(error) ||
        attempt === openRetryPolicy.maxAttempts - 1
      ) {
        throw error;
      }
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, openRetryPolicy.maxDelayMs);
      continue;
    }

    if (response.ok) {
      if (!response.body) {
        throw new ClientError(response.status, "Response body is null.", response.headers);
      }
      try {
        const deferred =
          response.headers.get(EVE_STREAM_TAIL_INDEX_HEADER) === EVE_STREAM_DEFERRED_TAIL_INDEX
            ? await readDeferredTailIndex(
                response.body,
                response.headers,
                input.streamReadIdleTimeoutMs ?? DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS,
              )
            : undefined;
        const body = deferred?.body ?? response.body;
        return {
          body,
          close: () => {
            connectionController.abort();
            void body.cancel().catch(() => {});
          },
          streamVersion: readMessageStreamVersion(response.headers),
          tailIndex: deferred?.tailIndex ?? parseTailIndexHeader(response.headers),
        };
      } catch (error) {
        connectionController.abort();
        if (
          !input.signal?.aborted &&
          !(error instanceof ClientError) &&
          isStreamDisconnectError(error) &&
          deferredTailTransportRetries < MAX_DEFERRED_TAIL_TRANSPORT_RETRIES &&
          attempt < openRetryPolicy.maxAttempts - 1
        ) {
          deferredTailTransportRetries += 1;
          await sleep(retryDelayMs, input.signal);
          retryDelayMs = Math.min(retryDelayMs * 2, openRetryPolicy.maxDelayMs);
          continue;
        }
        throw error;
      }
    }

    lastStatus = response.status;
    lastBody = await response.text();
    lastHeaders = response.headers;

    if (!retryPolicy.retryableErrorStatuses.has(response.status)) {
      throw new ClientError(response.status, lastBody, response.headers);
    }

    if (attempt < openRetryPolicy.maxAttempts - 1) {
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, openRetryPolicy.maxDelayMs);
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

const MAX_DEFERRED_TAIL_CONTROL_BYTES = 1_024;

async function readDeferredTailIndex(
  body: ReadableStream<Uint8Array>,
  headers: Headers,
  idleTimeoutMs: number,
): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly tailIndex: number }> {
  const reader = body.getReader();
  const lineChunks: Uint8Array[] = [];
  let lineLength = 0;
  let transferredReader = false;

  try {
    while (true) {
      const result = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (result.done) {
        throw new Error("Session stream disconnected before reporting its tail index.");
      }

      let offset = 0;
      while (offset < result.value.length) {
        const newline = result.value.indexOf(10, offset);
        const end = newline === -1 ? result.value.length : newline;
        if (end > offset) {
          const chunk = result.value.slice(offset, end);
          lineChunks.push(chunk);
          lineLength += chunk.byteLength;
          if (lineLength > MAX_DEFERRED_TAIL_CONTROL_BYTES) {
            throw new Error("Session stream tail-index control line is too large.");
          }
        }
        if (newline === -1) break;

        if (lineLength > 0) {
          const control = parseDeferredTailControl(concatBytes(lineChunks, lineLength), headers);
          const remainder = result.value.slice(newline + 1);
          const remainderBody = continueReadableStream(reader, remainder);
          transferredReader = true;
          return { body: remainderBody, tailIndex: control };
        }
        lineChunks.length = 0;
        lineLength = 0;
        offset = newline + 1;
      }
    }
  } finally {
    if (!transferredReader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

function parseDeferredTailControl(bytes: Uint8Array, headers: Headers): number {
  let control: unknown;
  try {
    control = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Session stream returned an invalid tail-index control line.");
  }
  if (typeof control !== "object" || control === null || Array.isArray(control)) {
    throw new Error("Session stream returned an invalid tail-index control line.");
  }
  const value = control as Record<string, unknown>;
  if (value.$eve === EVE_STREAM_ERROR_CONTROL) {
    const status = typeof value.status === "number" ? value.status : 500;
    const body = value.body === undefined ? "Session stream failed." : JSON.stringify(value.body);
    throw new ClientError(status, body, headers);
  }
  if (
    value.$eve !== EVE_STREAM_TAIL_INDEX_CONTROL ||
    typeof value.tailIndex !== "number" ||
    !Number.isSafeInteger(value.tailIndex)
  ) {
    throw new Error("Session stream returned an invalid tail-index control line.");
  }
  return value.tailIndex;
}

function concatBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function continueReadableStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainder: Uint8Array,
): ReadableStream<Uint8Array> {
  let firstChunk: Uint8Array | undefined = remainder.byteLength > 0 ? remainder : undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (firstChunk !== undefined) {
        controller.enqueue(firstChunk);
        firstChunk = undefined;
        return;
      }
      try {
        const result = await reader.read();
        if (result.done) {
          release();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
