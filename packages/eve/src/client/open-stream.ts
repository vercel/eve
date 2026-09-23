import type { MessageStreamEvent } from "#protocol/message.js";
import {
  EVE_STREAM_CONTROL_VERSION,
  EVE_STREAM_CONTROL_VERSION_QUERY,
  EVE_STREAM_TAIL_INDEX_HEADER,
} from "#protocol/message.js";
import type { MessageStreamVersion } from "#protocol/message-version.js";
import { createEveSessionStreamRoutePath } from "#protocol/routes.js";
import { throwIfAborted } from "#client/abort-signal.js";
import { ClientError } from "#client/client-error.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
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
  keepAlive = false,
): ResolvedStreamReconnectPolicy {
  if (policy && "reconnect" in policy && policy.reconnect === false) {
    return NO_STREAM_RECONNECT_POLICY;
  }

  const configured = policy as StreamReconnectPolicyOptions | undefined;
  return {
    retryableErrorStatuses: configured?.retryableErrorStatuses
      ? new Set(configured.retryableErrorStatuses)
      : DEFAULT_STREAM_RECONNECT_POLICY.retryableErrorStatuses,
    streamIdleReconnectPolicy: resolveRetryPolicy(configured?.streamIdleReconnectPolicy, {
      ...DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy,
      maxAttempts: keepAlive
        ? Infinity
        : DEFAULT_STREAM_RECONNECT_POLICY.streamIdleReconnectPolicy.maxAttempts,
    }),
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
  /** Called once after consuming the durable tail captured when the connection opens. */
  readonly onCaughtUp?: () => void;
  readonly host: string;
  /** Keep following empty streams unless the caller configures an idle retry limit. */
  readonly keepAlive?: boolean;
  readonly resolveReconnectPolicy?: () => StreamReconnectPolicy | undefined;
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

  const resolvePolicy = () =>
    resolveStreamReconnectPolicy(
      input.resolveReconnectPolicy === undefined
        ? input.streamReconnectPolicy
        : input.resolveReconnectPolicy(),
      input.keepAlive,
    );
  let retryPolicy = resolvePolicy();
  let idleRetryPolicy = retryPolicy.streamIdleReconnectPolicy;
  let startIndex = input.startIndex;
  let reconnectDelayMs = idleRetryPolicy.baseDelayMs;
  let idleReconnects = 0;
  let initialConnection = true;
  let tailIndex: number | undefined;
  let caughtUp = false;

  while (true) {
    retryPolicy = resolvePolicy();
    idleRetryPolicy = retryPolicy.streamIdleReconnectPolicy;
    let connection: OpenedStream;
    try {
      connection = await openStreamBody({
        ...input,
        retryPolicy,
        startIndex,
        requestTailIndex:
          (input.follow === false || input.onCaughtUp !== undefined) && tailIndex === undefined,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        return;
      }
      throw error;
    }

    if ((input.follow === false || input.onCaughtUp !== undefined) && tailIndex === undefined) {
      tailIndex = connection.tailIndex;
      if (tailIndex === undefined) {
        connection.close();
        throw new Error(
          `stream({ follow: false }) requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. ` +
            "The agent may be running an older eve version.",
        );
      }
    }

    if (!caughtUp && tailIndex !== undefined && startIndex > tailIndex) {
      caughtUp = true;
      input.onCaughtUp?.();
    }
    if (input.follow === false && tailIndex !== undefined && startIndex > tailIndex) {
      connection.close();
      return;
    }

    let deliveredEvent = false;
    let leaseEnded = false;
    try {
      for await (const event of readNdjsonStream(connection.body, {
        signal: input.signal,
        controlVersion: connection.controlVersion,
        idleTimeoutMs: input.streamReadIdleTimeoutMs ?? DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS,
        onLeaseEnded: () => {
          leaseEnded = true;
        },
        streamVersion: connection.streamVersion,
      })) {
        startIndex += 1;
        deliveredEvent = true;
        reconnectDelayMs = idleRetryPolicy.baseDelayMs;
        idleReconnects = 0;
        yield event;

        if (!caughtUp && tailIndex !== undefined && startIndex > tailIndex) {
          caughtUp = true;
          input.onCaughtUp?.();
        }
        if (input.follow === false && tailIndex !== undefined && startIndex > tailIndex) {
          return;
        }
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) throw error;
    } finally {
      connection.close();
    }

    idleRetryPolicy = resolvePolicy().streamIdleReconnectPolicy;
    if (input.signal?.aborted || input.startIndex < 0 || idleRetryPolicy.maxAttempts === 0) {
      return;
    }

    if (leaseEnded) {
      continue;
    }

    if (
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
  readonly controlVersion: "1" | undefined;
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
  const retryPolicy =
    input.retryPolicy ?? resolveStreamReconnectPolicy(input.streamReconnectPolicy, input.keepAlive);
  const openRetryPolicy = retryPolicy.streamOpenReconnectPolicy;
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;
  let retryDelayMs = openRetryPolicy.baseDelayMs;

  const controlVersion =
    input.startIndex >= 0 && retryPolicy.streamIdleReconnectPolicy.maxAttempts > 0
      ? EVE_STREAM_CONTROL_VERSION
      : undefined;
  const searchParams: Record<string, string> = {};
  if (controlVersion !== undefined) {
    searchParams[EVE_STREAM_CONTROL_VERSION_QUERY] = controlVersion;
  }
  if (input.startIndex !== 0) {
    searchParams.startIndex = String(input.startIndex);
  }
  if (input.requestTailIndex === true) {
    searchParams.includeTailIndex = "1";
  }

  for (let attempt = 0; attempt < openRetryPolicy.maxAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    const url = createClientUrl(
      input.host,
      createEveSessionStreamRoutePath(input.sessionId),
      Object.keys(searchParams).length > 0 ? searchParams : undefined,
    );

    const headers = await input.resolveHeaders();
    throwIfAborted(input.signal);
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
      let closed = false;
      return {
        body: response.body,
        close: () => {
          if (closed) return;
          closed = true;
          // Aborting a fetch after its response has resolved does not reliably
          // propagate cancellation through every local HTTP transport. Cancel
          // the body as well so its server-side Workflow stream releases its
          // live chunk and close listeners before a reconnect opens another.
          response.body?.cancel().catch(() => {});
          connectionController.abort();
        },
        controlVersion,
        streamVersion: readMessageStreamVersion(response.headers),
        tailIndex: parseTailIndexHeader(response.headers),
      };
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
