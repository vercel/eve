import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createSessionWaitingEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_VERSION_HEADER,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

export interface FakeEveRequest {
  readonly method: string;
  readonly path: string;
  readonly sessionId?: string;
  readonly body?: Record<string, unknown>;
}

/** Events a fake agent streams after it accepts one delivery. */
export type FakeEveTurn = (
  request: FakeEveRequest & { readonly deliveryId: string; readonly turnId: string },
) => readonly UnstampedMessageStreamEvent[];

interface FakeSession {
  readonly log: MessageStreamEvent[];
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
    events: readonly UnstampedMessageStreamEvent[],
    deliveryId?: string,
    sessionId = this.#currentSessionId,
  ): void {
    if (sessionId === undefined) throw new Error("No fake eve session exists yet.");
    const session = this.#session(sessionId);
    for (const event of events) {
      this.#eventCount += 1;
      const at = new Date(Date.UTC(2026, 0, 1) + this.#eventCount).toISOString();
      const id = `evt_fake_${String(this.#eventCount).padStart(4, "0")}`;
      const stamped = {
        ...event,
        meta: deliveryId === undefined ? { at, id } : { at, id, deliveryIds: [deliveryId] },
      } as MessageStreamEvent;
      session.log.push(stamped);
      const line = encoder.encode(`${JSON.stringify(stamped)}\n`);
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
      session = { log: [], streams: new Set() };
      this.#sessions.set(id, session);
    }
    return session;
  }

  #stream(sessionId: string, startIndex: number): Response {
    const session = this.#session(sessionId);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
          for (const event of session.log.slice(startIndex)) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
          session.streams.add(controller);
        },
        cancel() {
          session.streams.delete(controller);
        },
      }),
      { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
    );
  }
}

/** A fake agent that answers every message with the same completed reply. */
export function reply(text: string): FakeEveTurn {
  return ({ body, turnId }) => [
    ...(typeof body?.message === "string"
      ? [createMessageReceivedEvent({ message: body.message, sequence: 0, turnId })]
      : ([] as UnstampedMessageStreamEvent[])),
    createTurnStartedEvent({ sequence: 1, turnId }),
    createMessageCompletedEvent({
      finishReason: "stop",
      message: text,
      sequence: 2,
      stepIndex: 0,
      turnId,
    }),
    createTurnCompletedEvent({ sequence: 3, turnId }),
    createSessionWaitingEvent(),
  ];
}

/** A fake agent that accepts deliveries and leaves their events to the test. */
export function silent(): FakeEveTurn {
  return () => [];
}
