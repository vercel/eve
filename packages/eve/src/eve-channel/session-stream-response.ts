import type { Session } from "#channel/session.js";
import {
  EVE_MESSAGE_STREAM_CONTENT_TYPE,
  EVE_MESSAGE_STREAM_FORMAT,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_SESSION_ID_HEADER,
  EVE_STREAM_DEFERRED_TAIL_INDEX,
  EVE_STREAM_ERROR_CONTROL,
  EVE_STREAM_FORMAT_HEADER,
  EVE_STREAM_TAIL_INDEX_CONTROL,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/message.js";

export async function createSessionStreamResponse(
  request: Request,
  session: Session,
): Promise<Response> {
  const startIndex = parseStartIndex(request);
  if (startIndex instanceof Response) return startIndex;
  const includeTailIndex = parseIncludeTailIndex(request);
  const headers = createSessionStreamHeaders(session);

  if (includeTailIndex && parseDeferTailIndex(request)) {
    headers.set(EVE_STREAM_TAIL_INDEX_HEADER, EVE_STREAM_DEFERRED_TAIL_INDEX);
    return new Response(serializeDeferredTailAsNdjson(session, startIndex, request.signal), {
      headers,
    });
  }

  try {
    const tailIndex = includeTailIndex ? await session.getStreamTailIndex() : undefined;
    const events = await session.getEventStream({ startIndex });
    if (tailIndex !== undefined) {
      headers.set(EVE_STREAM_TAIL_INDEX_HEADER, String(tailIndex));
    }
    return new Response(
      serializeAsNdjson(events, request.signal, streamEventLimit(startIndex, tailIndex)),
      { headers },
    );
  } catch {
    return Response.json({ error: "Session not found.", ok: false }, { status: 404 });
  }
}

function createSessionStreamHeaders(session: Session): Headers {
  return new Headers({
    "cache-control": "no-store, no-transform",
    "content-type": EVE_MESSAGE_STREAM_CONTENT_TYPE,
    "x-accel-buffering": "no",
    [EVE_SESSION_ID_HEADER]: session.id,
    [EVE_STREAM_FORMAT_HEADER]: EVE_MESSAGE_STREAM_FORMAT,
    [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
  });
}

export function parseIncludeTailIndex(request: Request): boolean {
  const raw = new URL(request.url).searchParams.get("includeTailIndex");
  return raw === "1" || raw === "true";
}

export function parseDeferTailIndex(request: Request): boolean {
  const raw = new URL(request.url).searchParams.get("deferTailIndex");
  return raw === "1" || raw === "true";
}

export function parseStartIndex(request: Request): number | undefined | Response {
  const raw = new URL(request.url).searchParams.get("startIndex");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
    return Response.json(
      { error: "Expected startIndex to be an integer.", ok: false },
      { status: 400 },
    );
  }
  return parsed;
}

function streamEventLimit(
  startIndex: number | undefined,
  tailIndex: number | undefined,
): number | undefined {
  if (tailIndex === undefined) return undefined;
  const resolvedStartIndex =
    startIndex === undefined
      ? 0
      : startIndex < 0
        ? Math.max(0, tailIndex + 1 + startIndex)
        : startIndex;
  return Math.max(0, tailIndex - resolvedStartIndex + 1);
}

function serializeAsNdjson(
  events: ReadableStream<unknown>,
  signal: AbortSignal,
  eventLimit?: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let eventCount = 0;
  const transform = new TransformStream<unknown, Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("\n"));
      if (eventLimit === 0) controller.terminate();
    },
    transform(event, controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      eventCount += 1;
      if (eventCount === eventLimit) controller.terminate();
    },
  });
  void events.pipeTo(transform.writable, { signal }).catch(() => {});
  return transform.readable;
}

const STREAM_HEARTBEAT_INTERVAL_MS = 10_000;

function serializeDeferredTailAsNdjson(
  session: Session,
  startIndex: number | undefined,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let eventReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let tailIndex: number | undefined;
  let tailPromise: Promise<number>;
  let abort: (() => void) | undefined;

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };

  const cleanup = () => {
    stopHeartbeat();
    if (abort !== undefined) signal.removeEventListener("abort", abort);
    abort = undefined;
  };

  const cancelEventReader = async () => {
    const reader = eventReader;
    if (reader === undefined) return;
    eventReader = undefined;
    try {
      await reader.cancel();
    } catch {
      // The request or response body is already closing.
    } finally {
      reader.releaseLock();
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      tailPromise = Promise.resolve().then(() => session.getStreamTailIndex());
      void tailPromise.catch(() => {});
      controller.enqueue(encoder.encode("\n"));
      heartbeat = setInterval(() => {
        if (!cancelled && (controller.desiredSize ?? 0) > 0) {
          controller.enqueue(encoder.encode("\n"));
        }
      }, STREAM_HEARTBEAT_INTERVAL_MS);

      abort = () => {
        cancelled = true;
        cleanup();
        void cancelEventReader();
        controller.error(signal.reason);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
    async pull(controller) {
      if (cancelled) return;
      if (tailIndex === undefined) {
        try {
          tailIndex = await tailPromise;
          if (cancelled) return;
          stopHeartbeat();
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ $eve: EVE_STREAM_TAIL_INDEX_CONTROL, tailIndex })}\n`,
            ),
          );
          if (streamEventLimit(startIndex, tailIndex) === 0) {
            cancelled = true;
            cleanup();
            controller.close();
          }
        } catch {
          if (cancelled) return;
          cancelled = true;
          cleanup();
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                $eve: EVE_STREAM_ERROR_CONTROL,
                body: {
                  code: "stream_tail_unavailable",
                  error: "Session stream is unavailable.",
                  ok: false,
                },
                status: 503,
              })}\n`,
            ),
          );
          controller.close();
        }
        return;
      }

      try {
        if (eventReader === undefined) {
          const events = await session.getEventStream({ startIndex });
          if (cancelled) {
            await events.cancel().catch(() => {});
            return;
          }
          eventReader = serializeAsNdjson(
            events,
            signal,
            streamEventLimit(startIndex, tailIndex),
          ).getReader();
        }

        const reader = eventReader;
        const result = await reader.read();
        if (cancelled || eventReader !== reader) return;
        if (result.done) {
          cancelled = true;
          cleanup();
          if (eventReader === reader) eventReader = undefined;
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch {
        if (cancelled) return;
        cancelled = true;
        cleanup();
        const reader = eventReader;
        eventReader = undefined;
        reader?.releaseLock();
        controller.error(new Error("Session stream failed."));
      }
    },
    async cancel() {
      cancelled = true;
      cleanup();
      await cancelEventReader();
    },
  });
}
