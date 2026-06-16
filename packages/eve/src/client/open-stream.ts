import type { HandleMessageStreamEvent } from "#protocol/message.js";
import { createEveMessageStreamRoutePath } from "#protocol/routes.js";
import { ClientError } from "#client/client-error.js";
import { isStreamDisconnectError, readNdjsonStream } from "#client/ndjson.js";
import { createClientUrl } from "#client/url.js";

const STREAM_OPEN_RETRY_ATTEMPTS = 12;
const STREAM_OPEN_RETRY_DELAY_MS = 250;
const STREAM_OPEN_RETRYABLE_STATUS = new Set([404, 409, 425, 500, 502, 503, 504]);

/**
 * Internal configuration for opening a durable event stream.
 */
interface OpenStreamInput {
  readonly host: string;
  readonly maxReconnectAttempts: number;
  readonly resolveHeaders: () => Promise<Headers>;
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly startIndex: number;
}

type OpenStreamBodyInput = Omit<OpenStreamInput, "maxReconnectAttempts">;

/**
 * Opens a durable NDJSON event stream with automatic reconnection on socket
 * disconnection. Used by {@link ClientSession.stream}.
 */
export async function* openStreamIterable(
  input: OpenStreamInput,
): AsyncGenerator<HandleMessageStreamEvent> {
  let startIndex = input.startIndex;
  let remainingReconnectAttempts = input.maxReconnectAttempts;

  while (true) {
    const body = await openStreamBody({ ...input, startIndex });

    let disconnected = false;

    try {
      for await (const event of readNdjsonStream(body)) {
        startIndex += 1;
        yield event;
      }
    } catch (error) {
      if (!isStreamDisconnectError(error)) {
        throw error;
      }
      disconnected = true;
    }

    // Only reconnect on socket disconnection, not clean EOF or a
    // caller-initiated abort.
    if (!disconnected || input.signal?.aborted || remainingReconnectAttempts <= 0) {
      return;
    }

    remainingReconnectAttempts -= 1;
  }
}

/**
 * Opens one stream response body, retrying the short propagation window where
 * a just-acknowledged session may not yet be readable from the stream route.
 */
export async function openStreamBody(
  input: OpenStreamBodyInput,
): Promise<ReadableStream<Uint8Array>> {
  let lastStatus: number | undefined;
  let lastBody: string | undefined;

  for (let attempt = 0; attempt < STREAM_OPEN_RETRY_ATTEMPTS; attempt += 1) {
    const url = createClientUrl(
      input.host,
      createEveMessageStreamRoutePath(input.sessionId),
      input.startIndex > 0 ? { startIndex: String(input.startIndex) } : undefined,
    );

    const headers = await input.resolveHeaders();
    const response = await fetch(url, {
      headers,
      signal: input.signal ?? null,
    });

    if (response.ok) {
      if (!response.body) {
        throw new ClientError(response.status, "Response body is null.");
      }
      return response.body;
    }

    lastStatus = response.status;
    lastBody = await response.text();

    if (!STREAM_OPEN_RETRYABLE_STATUS.has(response.status)) {
      throw new ClientError(response.status, lastBody);
    }

    if (attempt < STREAM_OPEN_RETRY_ATTEMPTS - 1) {
      await sleep(STREAM_OPEN_RETRY_DELAY_MS);
    }
  }

  throw new ClientError(lastStatus ?? 0, lastBody ?? "Failed to open message stream.");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
