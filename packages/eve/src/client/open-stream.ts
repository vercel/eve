import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createEveMessageStreamRoutePath } from "#protocol/routes.js";
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
  const retryPolicy = resolveStreamReconnectPolicy(input.streamReconnectPolicy);
  const idleRetryPolicy = retryPolicy.streamIdleReconnectPolicy;
  let startIndex = input.startIndex;
  let reconnectDelayMs = idleRetryPolicy.baseDelayMs;
  let idleReconnects = 0;
  let initialConnection = true;

  while (true) {
    let body: ReadableStream<Uint8Array>;
    try {
      body = await openStreamBody({ ...input, retryPolicy, startIndex });
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
        reconnectDelayMs = idleRetryPolicy.baseDelayMs;
        idleReconnects = 0;
        yield event;
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) {
        throw error;
      }
    }

    if (input.signal?.aborted || input.startIndex < 0 || idleRetryPolicy.maxAttempts === 0) {
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
    await sleep(reconnectDelayMs, input.signal);
    if (input.signal?.aborted) {
      return;
    }
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, idleRetryPolicy.maxDelayMs);
  }
}

/**
 * Opens one stream response body, retrying transient failures with capped
 * exponential backoff (~35s total): brief network outages and the short
 * propagation window where a just-acknowledged session may not yet be
 * readable from the stream route.
 */
export async function openStreamBody(
  input: FollowStreamInput & { readonly retryPolicy?: ResolvedStreamReconnectPolicy },
): Promise<ReadableStream<Uint8Array>> {
  const retryPolicy = input.retryPolicy ?? DEFAULT_STREAM_RECONNECT_POLICY;
  const openRetryPolicy = retryPolicy.streamOpenReconnectPolicy;
  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastHeaders: Headers | undefined;
  let retryDelayMs = openRetryPolicy.baseDelayMs;

  for (let attempt = 0; attempt < openRetryPolicy.maxAttempts; attempt += 1) {
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
      return response.body;
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
