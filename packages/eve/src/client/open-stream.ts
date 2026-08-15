import type { MessageStreamEvent } from "#protocol/message.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/message.js";
import { createEveSessionStreamRoutePath } from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
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
  readonly streamReconnectPolicy?: StreamReconnectPolicy;
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
export function followStreamIterable(input: FollowStreamInput): AsyncIterable<MessageStreamEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
      const ownedAbort = new AbortController();
      const mergedAbort = mergeAbortSignals(input.signal, ownedAbort);
      const iterator = followStreamEvents({
        ...input,
        signal: mergedAbort.signal,
      });
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        mergedAbort.cleanup();
      };
      return {
        next: async () => {
          try {
            const result = await iterator.next();
            if (result.done) cleanup();
            return result;
          } catch (error) {
            cleanup();
            throw error;
          }
        },
        return: async (value?: MessageStreamEvent) => {
          ownedAbort.abort();
          try {
            return (await iterator.return?.(value)) ?? { done: true, value };
          } finally {
            cleanup();
          }
        },
        throw: async (error?: unknown) => {
          ownedAbort.abort();
          try {
            if (iterator.throw === undefined) throw error;
            return await iterator.throw(error);
          } finally {
            cleanup();
          }
        },
      };
    },
  };
}

function mergeAbortSignals(
  external: AbortSignal | undefined,
  owned: AbortController,
): { readonly cleanup: () => void; readonly signal: AbortSignal } {
  if (external === undefined) return { cleanup: () => {}, signal: owned.signal };
  if (external.aborted) {
    owned.abort(external.reason);
    return { cleanup: () => {}, signal: owned.signal };
  }
  const forward = () => owned.abort(external.reason);
  external.addEventListener("abort", forward, { once: true });
  return {
    cleanup: () => external.removeEventListener("abort", forward),
    signal: owned.signal,
  };
}

async function* followStreamEvents(input: FollowStreamInput): AsyncGenerator<MessageStreamEvent> {
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
  const ownedAbort = new AbortController();
  const forwardAbort = () => ownedAbort.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (input.signal?.aborted) forwardAbort();

  try {
    while (true) {
      let connection: OpenedStream;
      try {
        connection = await openStreamBody({
          ...input,
          retryPolicy,
          signal: ownedAbort.signal,
          startIndex,
          requestTailIndex: input.follow === false && tailIndex === undefined,
        });
      } catch (error) {
        if (ownedAbort.signal.aborted) {
          return;
        }
        throw error;
      }

      if (input.follow === false && tailIndex === undefined) {
        tailIndex = connection.tailIndex;
        if (tailIndex === undefined) {
          await connection.body.cancel().catch(() => {});
          throw new Error(
            `stream({ follow: false }) requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. ` +
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
          reconnectDelayMs = idleRetryPolicy.baseDelayMs;
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

      if (ownedAbort.signal.aborted || input.startIndex < 0 || idleRetryPolicy.maxAttempts === 0) {
        return;
      }

      if (
        !deliveredEvent &&
        !initialConnection &&
        (idleReconnects += 1) >= idleRetryPolicy.maxAttempts
      ) {
        return;
      }

      initialConnection = false;
      await sleep(reconnectDelayMs, ownedAbort.signal);
      if (ownedAbort.signal.aborted) {
        return;
      }
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, idleRetryPolicy.maxDelayMs);
    }
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
    ownedAbort.abort();
  }
}

/** An opened connection: the response body plus the tail index from the response header, if any. */
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
export async function openStreamBody(
  input: OpenStreamInput & { readonly retryPolicy?: ResolvedStreamReconnectPolicy },
): Promise<OpenedStream> {
  const retryPolicy = input.retryPolicy ?? DEFAULT_STREAM_RECONNECT_POLICY;
  const openRetryPolicy = retryPolicy.streamOpenReconnectPolicy;
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;
  let retryDelayMs = openRetryPolicy.baseDelayMs;

  const searchParams: Record<string, string> = {};
  if (input.startIndex !== 0) {
    searchParams.startIndex = String(input.startIndex);
  }
  if (input.requestTailIndex === true) {
    searchParams.includeTailIndex = "1";
  }

  for (let attempt = 0; attempt < openRetryPolicy.maxAttempts; attempt += 1) {
    const url = createClientUrl(
      input.host,
      createEveSessionStreamRoutePath(input.sessionId),
      Object.keys(searchParams).length > 0 ? searchParams : undefined,
    );

    const headers = await input.resolveHeaders();
    let response: Response;
    try {
      response = await fetch(url, {
        cache: "no-store",
        headers,
        redirect: input.redirect,
        signal: input.signal ?? null,
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
      return { body: response.body, tailIndex: parseTailIndexHeader(response.headers) };
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
