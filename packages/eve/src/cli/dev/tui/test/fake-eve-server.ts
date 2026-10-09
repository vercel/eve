import type { SessionEvent } from "#protocol/session-event.js";
import type { StoredLine } from "#protocol/session-events/envelope.js";
import { linesOf } from "#protocol/session-lines.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_VERSION_HEADER,
  EVE_STREAM_TAIL_INDEX_HEADER,
} from "#protocol/message.js";

/** What one fake model run spends, recorded with its terminal facts. */
const FAKE_USAGE = {
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  inputTokens: 1200,
  outputTokens: 150,
};

export interface FakeEveRequest {
  readonly method: string;
  readonly path: string;
  readonly sessionId?: string;
  readonly body?: Record<string, unknown>;
}

/** Events a fake agent streams after it accepts one delivery. */
export type FakeEveTurn = (
  request: FakeEveRequest & { readonly deliveryId: string; readonly turnId: string },
) => readonly SessionEvent[];

interface FakeSession {
  readonly log: StoredLine[];
  readonly streams: Set<ReadableStreamDefaultController<Uint8Array>>;
}

const encoder = new TextEncoder();

/**
 * An in-memory eve HTTP server for driving real clients through `fetch`.
 * Sessions keep a durable event log; streams replay from their cursor and then
 * follow live emissions, so reconnects and late subscribers behave like eve.
 */
export class FakeEveServer {
  readonly requests: FakeEveRequest[] = [];
  readonly #sessions = new Map<string, FakeSession>();
  readonly #respond: FakeEveTurn;
  readonly #fallback?: typeof fetch;
  #sessionCount = 0;
  #deliveryCount = 0;
  #eventCount = 0;
  #currentSessionId?: string;

  /** `fallback` serves routes outside the session API, such as dev runtime artifacts. */
  constructor(respond: FakeEveTurn = reply("Done."), fallback?: typeof fetch) {
    this.#respond = respond;
    if (fallback !== undefined) this.#fallback = fallback;
  }

  get sessionId(): string | undefined {
    return this.#currentSessionId;
  }

  /** Requests to one route, such as `POST /cancel`. */
  requestsTo(method: string, suffix: string): FakeEveRequest[] {
    return this.requests.filter(
      (request) => request.method === method && request.path.endsWith(suffix),
    );
  }

  /** Appends events to a session's durable stream; the current session by default. */
  emit(
    events: readonly SessionEvent[],
    _deliveryId?: string,
    sessionId = this.#currentSessionId,
  ): void {
    if (sessionId === undefined) throw new Error("No fake eve session exists yet.");
    const session = this.#session(sessionId);
    const at = new Date(Date.UTC(2026, 0, 1) + ++this.#eventCount).toISOString();
    for (const record of linesOf(events, at)) {
      session.log.push(record);
      const line = encoder.encode(`${JSON.stringify(record)}\n`);
      for (const stream of session.streams) stream.enqueue(line);
    }
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const match = /^\/eve\/v1\/session(?:\/([^/]+))?(?:\/([a-z]+))?$/u.exec(url.pathname);
    if (match === null && this.#fallback !== undefined) return await this.#fallback(input, init);
    const sessionId = match?.[1];
    const request: { -readonly [Key in keyof FakeEveRequest]: FakeEveRequest[Key] } = {
      method,
      path: url.pathname,
    };
    if (sessionId !== undefined) request.sessionId = sessionId;
    if (body !== undefined) request.body = body;
    this.requests.push(request);
    if (match === null) return new Response("Not found", { status: 404 });

    const action = match[2];
    if (method === "GET" && action === "stream" && sessionId !== undefined) {
      return this.#stream(sessionId, Number(url.searchParams.get("startIndex") ?? "0"));
    }
    if (method === "POST" && action === undefined) {
      const id = sessionId ?? this.#createSession();
      this.#currentSessionId = id;
      const deliveryId = `delivery_${String(++this.#deliveryCount)}`;
      const turnId = `turn_${String(this.#deliveryCount)}`;
      queueMicrotask(() =>
        this.emit(this.#respond({ ...request, deliveryId, turnId }), deliveryId),
      );
      return Response.json(
        { ok: true, status: "accepted", sessionId: id, deliveryId },
        { status: 202 },
      );
    }
    if (method === "POST" && action === "reset" && sessionId !== undefined) {
      return Response.json({ ok: true, status: "reset", previousSessionId: sessionId });
    }
    if (method === "POST" && sessionId !== undefined) {
      return Response.json({ ok: true, status: "accepted", sessionId });
    }
    return new Response("Not found", { status: 404 });
  };

  close(): void {
    for (const session of this.#sessions.values()) {
      for (const stream of session.streams) stream.close();
      session.streams.clear();
    }
  }

  #createSession(): string {
    const id = `session_${String(++this.#sessionCount)}`;
    this.#session(id);
    return id;
  }

  #session(id: string): FakeSession {
    let session = this.#sessions.get(id);
    if (session === undefined) {
      session = {
        log: [
          {
            at: new Date(Date.UTC(2026, 0, 1)).toISOString(),
            facts: [{ type: "session.started", data: {} }],
          },
        ],
        streams: new Set(),
      };
      this.#sessions.set(id, session);
    }
    return session;
  }

  #stream(sessionId: string, startIndex: number): Response {
    const session = this.#session(sessionId);
    const cursor = startIndex < 0 ? Math.max(0, session.log.length + startIndex) : startIndex;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          controller.enqueue(
            encoder.encode(`${JSON.stringify({ $eve: "position", next: cursor })}\n`),
          );
          for (const event of session.log.slice(cursor)) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          session.streams.add(controller);
        },
        cancel() {
          session.streams.delete(controller);
        },
      }),
      {
        headers: {
          [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
          [EVE_STREAM_TAIL_INDEX_HEADER]: String(session.log.length - 1),
        },
      },
    );
  }
}

/** A fake agent that answers every message with the same completed reply. */
export function reply(text: string): FakeEveTurn {
  return ({ body, deliveryId, turnId }) => {
    const runId = `${turnId}.run`;
    const partId = `${runId}.reply`;
    const scope = { turnId, runId };
    const events: SessionEvent[] = [
      { type: "delivery.admitted", data: { deliveryId } },
      { type: "turn.started", data: { turnId, cause: { deliveryId }, follows: null }, scope },
      {
        type: "delivery.consumed",
        data: {
          deliveryId,
          turnId,
          parts: typeof body?.message === "string" ? [{ kind: "text", text: body.message }] : [],
        },
      },
      { type: "model.requested", data: { runId, owner: { turnId } }, scope },
      { type: "model.started", data: { runId, modelId: "fake" }, scope },
      {
        type: "content.completed",
        data: { runId, partId, kind: "text", phase: "reply", value: text },
        scope,
      },
      { type: "model.settled", data: { runId, outcome: "completed", finishReason: "stop" }, scope },
      {
        type: "usage.recorded",
        data: { owner: { runId }, kind: "model", usage: FAKE_USAGE },
        scope,
      },
      { type: "turn.settled", data: { turnId, outcome: "completed", reply: [partId] }, scope },
      { type: "delivery.settled", data: { deliveryId, turnId, outcome: "handled" } },
    ];
    return events;
  };
}

/** A fake agent that accepts deliveries and leaves their events to the test. */
export function silent(): FakeEveTurn {
  return () => [];
}
