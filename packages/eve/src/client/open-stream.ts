import type { SessionStreamEvent } from "#protocol/session-event.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/message.js";
import { createEventReader } from "#protocol/session-lines.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
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
  /** False when the caller owns cursor recovery: one connection, then stop. */
  readonly reconnect: boolean;
  readonly retryableErrorStatuses: ReadonlySet<number>;
  readonly streamOpenReconnectPolicy: RetryPolicy;
}

/** A read times out only to detect a dead connection: the route sends a heartbeat every 10s. */
const DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS = 30_000;

/** Backoff between reconnects after a transport failure. Following readers retry forever. */
const RECONNECT_BACKOFF = { baseDelayMs: 250, maxDelayMs: 5_000 } as const;

const DEFAULT_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  reconnect: true,
  retryableErrorStatuses: new Set([404, 409, 425, 500, 502, 503, 504]),
  streamOpenReconnectPolicy: { baseDelayMs: 250, maxAttempts: 12, maxDelayMs: 5_000 },
};

const NO_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  ...DEFAULT_STREAM_RECONNECT_POLICY,
  reconnect: false,
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
    reconnect: true,
    retryableErrorStatuses: configured?.retryableErrorStatuses
      ? new Set(configured.retryableErrorStatuses)
      : DEFAULT_STREAM_RECONNECT_POLICY.retryableErrorStatuses,
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
  readonly resolveReconnectPolicy?: () => StreamReconnectPolicy | undefined;
  readonly streamReconnectPolicy?: StreamReconnectPolicy;
  /** @internal Test override for reconnecting an open stream that stops producing bytes. */
  readonly streamReadIdleTimeoutMs?: number;
  readonly resolveHeaders: () => Promise<Headers>;
  readonly redirect?: ClientRedirectPolicy;
  /** eve stream route path, such as a session stream or a parent-origin subagent stream. */
  readonly path: string;
  readonly signal?: AbortSignal;
  /** The position of the first line to read. Negative values count back from the tail. */
  readonly startIndex: number;
  /** Follow the live stream after the durable tail (default). `false` bounds the read at the tail. */
  readonly follow?: boolean;
}

/** One connection open; `requestTailIndex` asks the server to report the durable tail index. */
interface OpenStreamInput extends FollowStreamInput {
  readonly requestTailIndex?: boolean;
}

/** One stored line and its position. A line this version can't read has `line: undefined`. */
export interface FollowedLine {
  readonly line: StoredLine | undefined;
  readonly position: number;
}

/**
 * Follows one durable stream route from a position, reconnecting as the transport ends.
 *
 * A reader counts positions from its cursor, one per stored line, and jumps forward at each
 * position marker. `stream.ended` stops the follow; a lease end reconnects at once; anything
 * else is a transport failure, retried with capped backoff. Readers that follow retry forever,
 * and decide to stop from what they read. A tail-relative cursor becomes a position on the first
 * connection, from the tail the server reports.
 *
 * With `follow: false`, the first connection fixes the bound: the iterator yields lines until
 * the cursor passes that tail, reconnecting as needed, then returns instead of following.
 */
export async function* followStreamLines(input: FollowStreamInput): AsyncGenerator<FollowedLine> {
  const resolvePolicy = () =>
    resolveStreamReconnectPolicy(
      input.resolveReconnectPolicy === undefined
        ? input.streamReconnectPolicy
        : input.resolveReconnectPolicy(),
    );
  const bounded = input.follow === false || input.onCaughtUp !== undefined;
  let startIndex = input.startIndex;
  let reconnectDelayMs: number = RECONNECT_BACKOFF.baseDelayMs;
  let failures = 0;
  let tailIndex: number | undefined;
  let caughtUp = false;

  const passedTail = () => tailIndex !== undefined && startIndex > tailIndex;
  const noteProgress = () => {
    if (!caughtUp && passedTail()) {
      caughtUp = true;
      input.onCaughtUp?.();
    }
    return input.follow === false && passedTail();
  };

  while (true) {
    const retryPolicy = resolvePolicy();
    let connection: OpenedStream;
    try {
      connection = await openStreamBody({
        ...input,
        retryPolicy,
        startIndex,
        requestTailIndex: (bounded || startIndex < 0) && tailIndex === undefined,
      });
    } catch (error) {
      if (input.signal?.aborted) return;
      throw error;
    }

    if ((bounded || startIndex < 0) && tailIndex === undefined) {
      tailIndex = connection.tailIndex;
      if (tailIndex === undefined) {
        connection.close();
        throw new Error(
          `This read requires the server to report the ${EVE_STREAM_TAIL_INDEX_HEADER} header. ` +
            "The agent may be running an older eve version.",
        );
      }
      if (startIndex < 0) startIndex = Math.max(0, tailIndex + 1 + startIndex);
    }
    if (noteProgress()) {
      connection.close();
      return;
    }

    let streamEnded = false;
    let leaseEnded = false;
    try {
      for await (const record of readNdjsonStream(connection.body, {
        signal: input.signal,
        idleTimeoutMs: input.streamReadIdleTimeoutMs ?? DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS,
      })) {
        switch (record.kind) {
          case "transport":
            switch (record.record.$eve) {
              case "position":
                if (record.record.next > startIndex) startIndex = record.record.next;
                if (noteProgress()) return;
                break;
              case "stream.lease-ended":
                leaseEnded = true;
                break;
              case "stream.ended":
                streamEnded = true;
                break;
              case "heartbeat":
                break;
            }
            continue;
          case "unknown-transport":
            continue;
          case "commit":
          case "progress":
          case "invalid": {
            const position = startIndex;
            startIndex += 1;
            failures = 0;
            reconnectDelayMs = RECONNECT_BACKOFF.baseDelayMs;
            yield { line: record.kind === "invalid" ? undefined : record.line, position };
            if (noteProgress()) return;
          }
        }
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) throw error;
    } finally {
      connection.close();
    }

    if (streamEnded || input.signal?.aborted || !resolvePolicy().reconnect) return;
    if (leaseEnded) continue;

    // A transport failure. A one-shot read gives up after its budget of consecutive failures.
    failures += 1;
    if (input.follow === false && failures >= retryPolicy.streamOpenReconnectPolicy.maxAttempts) {
      throw new Error("The session stream kept disconnecting before the read reached its tail.");
    }
    await sleep(reconnectDelayMs, input.signal);
    if (input.signal?.aborted) return;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_BACKOFF.maxDelayMs);
  }
}

/** One v26 event read from a line, with the position to resume from once it's handled. */
export interface FollowedEvent {
  readonly event: SessionStreamEvent;
  /**
   * The cursor after this event: past its line once the line's last event is handled, at the
   * line before then, so a resume re-reads the rest of the line.
   */
  readonly cursor: number;
}

/**
 * Follows a stream route's v26 events: the records each line carries, rebuilt as v26 readers
 * expect them. Kept while v26 event types ride inside lines.
 */
export async function* followStreamIterable(
  input: FollowStreamInput,
): AsyncGenerator<FollowedEvent> {
  const events = createEventReader();
  for await (const { line, position } of followStreamLines(input)) {
    if (line === undefined) continue;
    const lineEvents = events.read(line, position);
    for (const [index, event] of lineEvents.entries()) {
      yield { cursor: index === lineEvents.length - 1 ? position + 1 : position, event };
    }
  }
}

/** An opened connection: the response body plus the tail index from the response header, if any. */
interface OpenedStream {
  readonly body: ReadableStream<Uint8Array>;
  close(): void;
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
    input.retryPolicy ?? resolveStreamReconnectPolicy(input.streamReconnectPolicy);
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
    input.signal?.throwIfAborted();
    const url = createClientUrl(
      input.host,
      input.path,
      Object.keys(searchParams).length > 0 ? searchParams : undefined,
    );

    const headers = await input.resolveHeaders();
    input.signal?.throwIfAborted();
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
      readMessageStreamVersion(response.headers);
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
