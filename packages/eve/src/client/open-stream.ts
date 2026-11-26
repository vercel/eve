import type { SessionStreamEvent } from "#protocol/session-event.js";
import { EVE_STREAM_TAIL_INDEX_HEADER } from "#protocol/session-http.js";
import { createEventReader } from "#protocol/session-lines.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { isV26Line } from "#protocol/v26-lines.js";
import {
  ClientError,
  ClientSessionStrandedError,
  createClientError,
} from "#client/client-error.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import { throwIfAborted } from "#client/abort-signal.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
import { readMessageStreamVersion } from "#client/stream-version.js";
import type { ClientRedirectPolicy, ReconnectOptions } from "#client/types.js";
import { isRefusedRedirect, toClientNetworkError } from "#client/client-network-error.js";
import { createClientUrl } from "#client/url.js";
import { waitWithSignal } from "#shared/wait-with-signal.js";

interface ResolvedStreamReconnectPolicy {
  readonly reconnect: boolean;
  readonly retryableStatuses: ReadonlySet<number>;
  readonly baseDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
}

const DEFAULT_STREAM_READ_IDLE_TIMEOUT_MS = 30_000;

export const RECONNECT_BACKOFF = { baseDelayMs: 250, maxDelayMs: 5_000 } as const;

export const DEFAULT_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  reconnect: true,
  retryableStatuses: new Set([404, 409, 425, 500, 502, 503, 504]),
  baseDelayMs: 250,
  maxAttempts: 12,
  maxDelayMs: 5_000,
};

const NO_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  ...DEFAULT_STREAM_RECONNECT_POLICY,
  reconnect: false,
  maxAttempts: 1,
};

export function isRetryableStreamError(
  error: unknown,
  statuses: ReadonlySet<number> = DEFAULT_STREAM_RECONNECT_POLICY.retryableStatuses,
): boolean {
  if (error instanceof ClientSessionStrandedError) return false;
  if (SessionNotActiveError.is(error)) return statuses.has(409);
  if (error instanceof ClientError)
    return error.code !== "session_version_unsupported" && statuses.has(error.status);
  return isStreamDisconnectError(error);
}

function resolveStreamReconnectPolicy(
  options: false | ReconnectOptions | undefined,
): ResolvedStreamReconnectPolicy {
  if (options === false) return NO_STREAM_RECONNECT_POLICY;
  const defaults = DEFAULT_STREAM_RECONNECT_POLICY;
  return {
    reconnect: true,
    retryableStatuses: options?.retryableStatuses
      ? new Set(options.retryableStatuses)
      : defaults.retryableStatuses,
    baseDelayMs: options?.baseDelayMs ?? defaults.baseDelayMs,
    maxAttempts: options?.maxAttempts ?? defaults.maxAttempts,
    maxDelayMs: options?.maxDelayMs ?? defaults.maxDelayMs,
  };
}

interface FollowStreamInput {
  readonly onOpen?: (headers: Headers) => void;
  readonly onPosition?: (position: number) => void;
  readonly onCaughtUp?: () => void;
  readonly baseUrl: string;
  readonly resolveReconnectPolicy?: () => false | ReconnectOptions | undefined;
  readonly reconnect?: false | ReconnectOptions;
  /** @internal */
  readonly streamReadIdleTimeoutMs?: number;
  readonly resolveHeaders: () => Promise<Headers>;
  readonly redirect?: ClientRedirectPolicy;
  readonly path: string;
  readonly searchParams?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly startIndex: number;
  readonly follow?: boolean;
  readonly opened?: PendingStream;
}

interface OpenStreamInput extends FollowStreamInput {
  readonly requestTailIndex?: boolean;
}

export interface FollowedLine {
  readonly line: StoredLine | undefined;
  readonly position: number;
}

export async function* followStreamLines(input: FollowStreamInput): AsyncGenerator<FollowedLine> {
  const resolvePolicy = () =>
    resolveStreamReconnectPolicy(
      input.resolveReconnectPolicy === undefined ? input.reconnect : input.resolveReconnectPolicy(),
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

  let opened = input.opened;
  while (true) {
    const retryPolicy = resolvePolicy();
    const requestTailIndex = (bounded || startIndex < 0) && tailIndex === undefined;
    const early = opened;
    opened = undefined;
    let connection: OpenedStream;
    try {
      const adopted =
        early === undefined
          ? undefined
          : requestTailIndex
            ? void early.cancel()
            : await waitWithSignal(early.opened, input.signal).catch((error: unknown) => {
                early.cancel();
                throw error;
              });
      connection =
        adopted ?? (await openStreamBody({ ...input, retryPolicy, startIndex, requestTailIndex }));
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
    try {
      input.onOpen?.(connection.headers);
    } catch (error) {
      connection.close();
      throw error;
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
                input.onPosition?.(startIndex);
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
            if (record.kind === "invalid" && isV26Line(record.value)) {
              throw new ClientError(
                409,
                JSON.stringify({
                  code: "session_version_unsupported",
                  error: "This session was started by an earlier eve version. Start a new session.",
                }),
              );
            }
            const position = startIndex;
            startIndex += 1;
            failures = 0;
            reconnectDelayMs = RECONNECT_BACKOFF.baseDelayMs;
            yield { line: record.kind === "invalid" ? undefined : record.line, position };
            input.onPosition?.(startIndex);
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

    failures += 1;
    if (input.follow === false && failures >= retryPolicy.maxAttempts) {
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

export interface PendingStream {
  readonly opened: Promise<OpenedStream | undefined>;
  cancel(): void;
}

export interface OpenedStream {
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array>;
  close(): void;
  readonly tailIndex: number | undefined;
}

export async function openStreamBody(
  input: OpenStreamInput & { readonly retryPolicy?: ResolvedStreamReconnectPolicy },
): Promise<OpenedStream> {
  const retryPolicy = input.retryPolicy ?? resolveStreamReconnectPolicy(input.reconnect);
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;
  let retryDelayMs = retryPolicy.baseDelayMs;

  const searchParams: Record<string, string> = { ...input.searchParams };
  if (input.startIndex !== 0) {
    searchParams.startIndex = String(input.startIndex);
  }
  if (input.requestTailIndex === true) {
    searchParams.includeTailIndex = "1";
  }
  if (input.follow === false) {
    searchParams.follow = "false";
  }

  for (let attempt = 0; attempt < retryPolicy.maxAttempts; attempt += 1) {
    throwIfAborted(input.signal);
    const url = createClientUrl(
      input.baseUrl,
      input.path,
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
      if (input.redirect === "error" && isRefusedRedirect(error)) {
        throw new Error("The session stream refused a redirect. Use the final agent URL instead.", {
          cause: error,
        });
      }
      if (
        input.signal?.aborted ||
        !isStreamDisconnectError(error) ||
        attempt === retryPolicy.maxAttempts - 1
      ) {
        throw toClientNetworkError(error, signal);
      }
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, retryPolicy.maxDelayMs);
      continue;
    }

    if (response.ok) {
      if (!response.body) {
        throw new ClientError(response.status, "Response body is null.", response.headers);
      }
      try {
        readMessageStreamVersion(response.headers);
      } catch (error) {
        response.body.cancel().catch(() => {});
        connectionController.abort();
        throw error;
      }
      let closed = false;
      return {
        headers: response.headers,
        body: response.body,
        close: () => {
          if (closed) return;
          closed = true;
          response.body?.cancel().catch(() => {});
          connectionController.abort();
        },
        tailIndex: parseTailIndexHeader(response.headers),
      };
    }

    lastStatus = response.status;
    lastBody = await response.text();
    lastHeaders = response.headers;

    const error = createClientError(response.status, lastBody, response.headers);
    if (!isRetryableStreamError(error, retryPolicy.retryableStatuses)) {
      throw error;
    }

    if (attempt < retryPolicy.maxAttempts - 1) {
      await sleep(retryDelayMs, input.signal);
      retryDelayMs = Math.min(retryDelayMs * 2, retryPolicy.maxDelayMs);
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
