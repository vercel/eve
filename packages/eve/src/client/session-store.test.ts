import {
  activeTurn,
  idle,
  delivery,
  openInteractions,
  turn,
  position,
  session,
} from "#protocol/session-projection/public-view.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachSessionStore,
  detachSessionStore,
  SessionStore,
  type SessionStoreInit,
} from "#client/session-store.js";
import { Client } from "#client/client.js";
import { testTurnFacts } from "#internal/testing/events.js";
import { convertLegacyEvents } from "#internal/legacy-events.js";
import { KITCHEN_SINK } from "#execution/v26-history.fixtures.js";
import { createV26HistoryReader } from "#execution/v26-history.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";
import type { SessionEvent, SessionStreamEvent } from "#protocol/session-event.js";

const stores: SessionStore[] = [];
function store(options: SessionStoreInit = {}) {
  const result = new SessionStore({ baseUrl: "https://eve.test", ...options });
  stores.push(result);
  return result;
}
afterEach(() => {
  for (const current of stores.splice(0)) detachSessionStore(current);
  vi.restoreAllMocks();
});

/** An append-only agent stream, independent of when its POST acknowledgements arrive. */
function agent(onPost?: (deliveryId: string, path: string) => Promise<void> | void) {
  const log: string[] = [];
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const reads: { start: number; signal: AbortSignal | null | undefined }[] = [];
  const posts: string[] = [];
  const cancellations: unknown[] = [];
  let sequence = 0;
  let controlSequence = 0;
  const encoder = new TextEncoder();
  const append = (events: readonly SessionEvent[], together = false) => {
    const groups = together ? [events] : events.map((event) => [event]);
    const lines = groups
      .flatMap((group) => linesOf(group, "2026-10-10T00:00:00.000Z"))
      .map((line) => `${JSON.stringify(line)}\n`);
    log.push(...lines);
    for (const controller of open) controller.enqueue(encoder.encode(lines.join("")));
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
    const path = new URL(String(request instanceof Request ? request.url : request));
    if ((init?.method ?? "GET") === "POST") {
      posts.push(path.pathname);
      if (path.pathname.endsWith("/cancel")) {
        const body = JSON.parse(String(init?.body)) as { turnId?: string | null };
        cancellations.push(body);
        const deliveryId = `cancel_${controlSequence++}`;
        if (body.turnId === null)
          append(
            [
              { type: "delivery.admitted", data: { deliveryId, source: { control: "cancel" } } },
              { type: "delivery.settled", data: { deliveryId, outcome: "applied" } },
            ],
            true,
          );
        return Response.json({ ok: true, sessionId: "session_1", deliveryId });
      }
      if (/\/(clear|compact|reset)$/.test(path.pathname)) {
        const deliveryId = `control_${controlSequence++}`;
        await onPost?.(deliveryId, path.pathname);
        return Response.json({ ok: true, sessionId: "session_1", deliveryId });
      }
      const deliveryId = `d_${sequence++}`;
      await onPost?.(deliveryId, path.pathname);
      return Response.json(
        { deliveryId, sessionId: "session_1", status: "accepted" },
        { status: 202 },
      );
    }
    const start = Number(path.searchParams.get("startIndex") ?? "0");
    reads.push({ start, signal: init?.signal });
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(log.slice(start).join("")));
          open.add(controller);
          init?.signal?.addEventListener(
            "abort",
            () => {
              open.delete(controller);
              controller.error(init.signal?.reason);
            },
            { once: true },
          );
        },
      }),
      {
        headers: {
          [EVE_STREAM_TAIL_INDEX_HEADER]: String(log.length - 1),
          [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION,
        },
      },
    );
  });
  return { append, log, reads, posts, cancellations };
}
function texts(current: SessionStore) {
  return current.snapshot.messages.map(
    (message) =>
      `${message.role}: ${message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")}`,
  );
}
const initialSession = { sessionId: "session_1", streamIndex: 0 };
const savedV26 = KITCHEN_SINK.slice(0, 9).filter(
  (record) => (record as { type: string }).type !== "reasoning.completed",
);

function savedLegacyHistory(server: ReturnType<typeof agent>): SessionStreamEvent[] {
  const reader = createV26HistoryReader();
  server.log.push(
    ...savedV26.map(
      (record, position) =>
        `${JSON.stringify(reader.read(record, position) ?? { $eve: "position", next: position + 1 })}\n`,
    ),
  );
  return JSON.parse(JSON.stringify(convertLegacyEvents(savedV26))) as SessionStreamEvent[];
}
const personWait: SessionEvent[] = [
  { type: "model.settled", data: { runId: "run_0", outcome: "completed" } },
  {
    type: "interaction.opened",
    data: {
      interactionId: "question",
      request: { kind: "question", prompt: "Which?" },
      subject: { turnId: "turn_0" },
    },
  },
  { type: "turn.paused", data: { turnId: "turn_0", awaiting: [{ interactionId: "question" }] } },
  {
    type: "delivery.settled",
    data: { deliveryId: "asked", outcome: "awaiting-input", turnId: "turn_0" },
  },
];
/** Turn 0 asks a person and its delivery settles, leaving no machine work. */
function appendPersonWait(server: ReturnType<typeof agent>) {
  server.append(testTurnFacts(0, "Later.", ["asked"]).slice(0, 4));
  server.append(personWait, true);
}

describe("SessionStore acceptance and observation", () => {
  it("preserves refreshed inbox handles in saved snapshots and session-change callbacks", async () => {
    agent();
    const fetchAgent = vi.mocked(fetch).getMockImplementation()!;
    const inboxes: Array<string | undefined> = [];
    vi.mocked(fetch).mockImplementation(async (request, init) => {
      const response = await fetchAgent(request, init);
      if (init?.method !== "POST") return response;
      inboxes.push(JSON.parse(String(init.body)).inbox);
      const accepted = (await response.json()) as Record<string, unknown>;
      return Response.json({
        ...accepted,
        inbox: `inbox_${inboxes.length}`,
      });
    });
    const current = store({ initialSession: { ...initialSession, inbox: "inbox_0" } });
    const changed = vi.fn();
    current.setCallbacks({ onSessionChange: changed });
    const before = current.snapshot.session;
    expect(before?.inbox).toBe("inbox_0");

    // No stream facts arrive: the POST receipt must publish the refreshed state.
    await current.send({ message: "Alice starts the conversation." });
    expect(current.snapshot.session).toEqual({ ...initialSession, inbox: "inbox_1" });
    expect(changed).toHaveBeenLastCalledWith(current.snapshot.session);
    expect(before?.inbox).toBe("inbox_0");

    const restored = store({
      initialSession: JSON.parse(JSON.stringify(changed.mock.lastCall![0])),
    });
    await restored.send({ message: "Bob continues after reopening it." });
    expect(inboxes).toEqual(["inbox_0", "inbox_1"]);
    expect(restored.snapshot.session).toEqual({ ...initialSession, inbox: "inbox_2" });
  });

  it.each([false, true])(
    "observes its accepted turn once, including a reply already at the tail (early: %s)",
    async (early) => {
      const server = agent(() => {
        if (early) server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
      });
      const current = store();
      const finished = vi.fn();
      current.setCallbacks({ onFinish: finished });
      const sent = current.send({ message: "sunny." });
      const echoId = current.snapshot.messages[0]!.id;
      expect(texts(current)).toEqual(["user: sunny."]);
      await expect(sent).resolves.toEqual({ deliveryId: "d_0", sessionId: "session_1" });
      if (!early) {
        expect(finished).not.toHaveBeenCalled();
        expect(current.snapshot.status).toBe("busy");
        server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
      }
      await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
      expect(texts(current)).toEqual(["user: sunny.", "assistant: Sunny."]);
      expect(current.snapshot.messages[0]!.id).toBe(echoId);
      expect(finished).toHaveBeenCalledTimes(early ? 0 : 1);
      expect(server.reads).toHaveLength(1);
      current.newSession();
      await expect((await sent).result()).resolves.toMatchObject({
        status: "completed",
        reply: "Sunny.",
        sessionEnded: false,
      });
      expect(server.reads).toHaveLength(2);
    },
  );

  it("records a reply that beat its POST without replaying a historical failure callback", async () => {
    const server = agent(() =>
      server.append(
        testTurnFacts(0, "Earlier.", ["d_0"]).map((event): SessionEvent =>
          event.type === "turn.settled"
            ? {
                ...event,
                data: {
                  ...event.data,
                  outcome: "failed",
                  error: { code: "EARLIER", message: "Earlier failure" },
                },
              }
            : event,
        ),
      ),
    );
    const current = store();
    const onError = vi.fn();
    const onFinish = vi.fn();
    current.setCallbacks({ onError, onFinish });
    const receipt = await current.send({ message: "sunny." });
    await vi.waitFor(() => expect(turn(current.snapshot.view, "turn_0")?.status).toBe("settled"));
    expect(current.snapshot.error?.message).toBe("Earlier failure");
    expect(onError).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    await expect(receipt.result()).resolves.toMatchObject({ status: "failed" });
  });

  it("does not publish another reader's cursor ahead of its own committed events", async () => {
    const server = agent();
    const session = new Client({ baseUrl: "https://eve.test" }).sessions.attach("session_1");
    const current = store({ session });
    const receipt = await session.send("sunny.");
    server.append(testTurnFacts(0, "Sunny.", [receipt.deliveryId]));
    await receipt.result();
    expect(session.state.streamIndex).toBeGreaterThan(0);
    const prepared = Promise.withResolvers<void>();
    current.setCallbacks({
      prepareSend: async (input) => {
        await prepared.promise;
        return input;
      },
    });
    const sending = current.send({ message: "later." });
    try {
      expect(current.snapshot.events).toEqual([]);
      expect(current.snapshot.session?.streamIndex).toBe(0);
    } finally {
      prepared.resolve();
      await sending;
    }
  });

  it("publishes matching root event prefixes while recursive following is active", async () => {
    const server = agent();
    const current = store({ initialSession, followAgents: true });
    const positions: { cursor: number; prefix: number }[] = [];
    current.subscribe(() => {
      const snapshot = current.snapshot;
      const last = snapshot.events.filter((event) => event.meta.endOfLine !== false).at(-1);
      positions.push({
        cursor: snapshot.session?.streamIndex ?? 0,
        prefix: last === undefined ? 0 : last.meta.position.line + 1,
      });
    });
    server.append(testTurnFacts(0, "Earlier.", ["earlier"]));
    await current.resume();
    server.append(testTurnFacts(1, "Later.", ["later"]));
    await vi.waitFor(() => expect(current.snapshot.session?.streamIndex).toBe(server.log.length));
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every(({ cursor, prefix }) => cursor === prefix)).toBe(true);
  });

  it("keeps identical messages distinct when the stream beats reversed POST acknowledgements", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const server = agent((id) => (id === "d_0" ? first.promise : second.promise));
    const current = store({ initialSession });
    const one = current.send({ message: "sunny." });
    const two = current.send({ message: "sunny.", turnPolicy: "queue" });
    const echoId = current.snapshot.messages[0]!.id;
    const consumed = (event: SessionEvent): SessionEvent =>
      event.type === "delivery.consumed"
        ? { ...event, data: { ...event.data, parts: [{ kind: "text", text: "sunny." }] } }
        : event;
    server.append(testTurnFacts(0, "First.", ["d_0"]).map(consumed));
    server.append(testTurnFacts(1, "Second.", ["d_1"]).map(consumed));
    second.resolve();
    await two;
    first.resolve();
    await one;
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    const confirmed = current.snapshot.messages.filter((message) => message.role === "user");
    expect(confirmed).toHaveLength(2);
    expect(confirmed[0]!.id).toBe(echoId);
    expect(new Set(confirmed.map((message) => message.id)).size).toBe(2);
    expect(
      confirmed.map((message) =>
        message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      ),
    ).toEqual(["sunny.", "sunny."]);
    expect(server.reads).toHaveLength(1);
  });

  it("shares session creation and sends a steering message without waiting for an earlier turn", async () => {
    const created = Promise.withResolvers<void>();
    const server = agent((id) => (id === "d_0" ? created.promise : undefined));
    const current = store();
    const one = current.send({ message: "sunny." });
    const two = current.send({ message: "instead", turnPolicy: "steer" });
    let attachmentError: unknown;
    try {
      attachSessionStore(current);
    } catch (error) {
      attachmentError = error;
    }
    created.resolve();
    expect(await one).toEqual({ deliveryId: "d_0", sessionId: "session_1" });
    expect(await two).toEqual({ deliveryId: "d_1", sessionId: "session_1" });
    expect(server.posts).toEqual(["/eve/v1/session", "/eve/v1/session/session_1"]);
    expect(server.reads).toHaveLength(1);
    expect(attachmentError).toBeUndefined();
  });

  it("does not replay historical errors into a new pending send", async () => {
    const receipt = Promise.withResolvers<void>();
    const server = agent(() => receipt.promise);
    server.append(
      testTurnFacts(0, "Earlier.", ["old"]).map((event): SessionEvent =>
        event.type === "turn.settled"
          ? {
              ...event,
              data: {
                ...event.data,
                outcome: "failed",
                error: { code: "EARLIER", message: "Earlier failure" },
              },
            }
          : event,
      ),
    );
    const current = store({ initialSession });
    const onError = vi.fn();
    const onEvent = vi.fn();
    const onFinish = vi.fn();
    current.setCallbacks({ onError, onEvent, onFinish });
    const sending = current.send({ message: "New task." });
    try {
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(8));
      expect(onError).not.toHaveBeenCalled();
      expect(onFinish).not.toHaveBeenCalled();
    } finally {
      receipt.resolve();
      await sending;
    }
    expect(current.snapshot.error).toBeUndefined();
    expect(
      current.snapshot.messages.find((message) => message.id.startsWith("optimistic:"))?.metadata
        ?.status,
    ).toBe("submitted");
  });

  it("publishes committed work while an unrelated message waits for its receipt", async () => {
    const receipt = Promise.withResolvers<void>();
    const server = agent((id) => (id === "d_1" ? receipt.promise : undefined));
    const current = store({ initialSession, followWhile: () => false });
    await current.send({ message: "First task." });
    const echo = current.snapshot.messages[0]!.id;
    const sending = current.send({ message: "Queued task.", turnPolicy: "queue" });
    try {
      server.append(testTurnFacts(0, "First done.", ["d_0"]));
      await vi.waitFor(() => expect(turn(current.snapshot.view, "turn_0")?.status).toBe("settled"));
      const users = current.snapshot.messages.filter((message) => message.role === "user");
      expect(users).toHaveLength(2);
      expect(users[0]?.id).toBe(echo);
      expect(texts(current)).toContain("assistant: First done.");
      expect(server.reads[0]?.signal?.aborted).toBe(false);
    } finally {
      receipt.resolve();
      await sending;
    }
  });

  it("keeps a live finish when its event observer starts catch-up", async () => {
    const server = agent();
    const current = store({ initialSession });
    await current.send({ message: "First task." });
    let resumed: Promise<void> | undefined;
    const onFinish = vi.fn();
    current.setCallbacks({
      onFinish,
      onEvent: (event) => {
        if (event.type === "turn.settled") resumed = current.resume();
      },
    });
    server.append(testTurnFacts(0, "Done.", ["d_0"]));
    await vi.waitFor(() => expect(resumed).toBeDefined());
    await resumed;
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("resumes through catch-up without waiting for an in-flight turn to end", async () => {
    const server = agent();
    server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4));
    const current = store({ initialSession });
    await current.resume();
    expect(current.snapshot.status).toBe("busy");
    expect(current.snapshot.events).toHaveLength(4);
    server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(4));
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    await current.resume();
    expect(current.snapshot.events).toHaveLength(8);
    expect(server.reads).toHaveLength(1);
  });

  it.each([2, 4])(
    "resumes a saved prefix of %i facts using line positions, not event counts",
    async (savedFacts) => {
      const server = agent();
      const events = testTurnFacts(0, "Sunny.", ["d_0"]);
      const at = "2026-10-10T00:00:00.000Z";
      server.append(events.slice(0, 4), true);
      server.append(events.slice(4));
      const saved = eventsOfLine(linesOf(events.slice(0, 4), at)[0]!, 0, at).slice(0, savedFacts);
      const current = store({
        initialEvents: saved,
        initialSession: { ...initialSession, streamIndex: 1 },
      });
      const received = vi.fn();
      current.setCallbacks({ onEvent: received });
      await current.resume();
      expect(server.reads[0]?.start).toBe(savedFacts === 4 ? 1 : 0);
      expect(current.snapshot.events).toHaveLength(8);
      expect(texts(current)).toEqual(["user: sunny.", "assistant: Sunny."]);
      expect(received).toHaveBeenCalledTimes(8 - savedFacts);
    },
  );

  it("retains converted history's source coverage beyond its last materialized fact", async () => {
    const server = agent();
    const converted = savedLegacyHistory(server);
    expect(savedV26).toHaveLength(8);
    expect(converted).toHaveLength(11);
    expect(converted.at(-1)?.meta).toMatchObject({ position: { line: 6 }, next: 8 });
    const current = store({
      initialEvents: converted,
      initialSession: { sessionId: "fixture", streamIndex: 8 },
    });
    expect(position(current.snapshot.view)).toBe(8);
    expect(current.snapshot.session).toEqual({ sessionId: "fixture", streamIndex: 8 });
    expect(fetch).not.toHaveBeenCalled();
    const hydrated = current.snapshot.events;
    await current.resume();
    expect(server.reads.map(({ start }) => start)).toEqual([8]);
    expect(current.snapshot.session?.streamIndex).toBe(8);
    expect(current.snapshot.events).toBe(hydrated);
    detachSessionStore(current);
    attachSessionStore(current);
    await vi.waitFor(() => expect(server.reads).toHaveLength(2));
    expect(server.reads.map(({ start }) => start)).toEqual([8, 8]);
    expect(current.snapshot.session?.streamIndex).toBe(8);
  });

  it("does not use a handle cursor to extend a native history prefix", async () => {
    const server = agent();
    const facts = testTurnFacts(0, "Sunny.", ["d_0"]);
    server.append(facts);
    const saved = facts
      .slice(0, 4)
      .flatMap((fact, line) =>
        eventsOfLine(linesOf([fact], "2026-10-10T00:00:00.000Z")[0]!, line, ""),
      );
    const current = store({
      initialEvents: saved,
      initialSession: { ...initialSession, streamIndex: 1_000 },
      followWhile: () => false,
    });
    expect(current.snapshot.session?.streamIndex).toBe(4);
    await current.resume();
    expect(server.reads[0]?.start).toBe(4);
    expect(current.snapshot.session?.streamIndex).toBe(8);
    expect(current.snapshot.events).toHaveLength(8);
  });

  it("keeps source coverage before a partially hydrated native commit", async () => {
    const server = agent();
    const converted = savedLegacyHistory(server);
    const facts = testTurnFacts(1, "Later.", ["later"]);
    const at = "2026-10-10T00:00:00.000Z";
    server.append(facts, true);
    const partial = eventsOfLine(linesOf(facts, at)[0]!, 8, at).slice(0, 2);
    const current = store({
      initialEvents: [...converted, ...partial],
      initialSession: { ...initialSession, streamIndex: 1_000 },
      followWhile: () => false,
    });
    const received = vi.fn();
    current.setCallbacks({ onEvent: received });
    expect(position(current.snapshot.view)).toBe(8);
    expect(current.snapshot.session?.streamIndex).toBe(8);
    await current.resume();
    expect(server.reads[0]?.start).toBe(8);
    expect(current.snapshot.session?.streamIndex).toBe(9);
    expect(current.snapshot.events).toHaveLength(11 + facts.length);
    expect(received).toHaveBeenCalledTimes(facts.length - partial.length);
  });

  it("retains covered source lines when detaching in the next native commit", async () => {
    const server = agent();
    const converted = savedLegacyHistory(server);
    server.append(testTurnFacts(1, "Later.", ["later"]), true);
    const session = new Client({ baseUrl: "https://eve.test" }).sessions.attach("session_1", {
      streamIndex: 1_000,
    });
    const current = store({ session, initialEvents: converted, followWhile: () => false });
    let interrupted = false;
    current.setCallbacks({
      onEvent: () => {
        if (interrupted) return;
        interrupted = true;
        detachSessionStore(current);
      },
    });
    await expect(current.resume()).rejects.toMatchObject({ name: "AbortError" });
    expect(current.snapshot.session?.streamIndex).toBe(8);
    await current.resume();
    expect(server.reads.map(({ start }) => start)).toEqual([8, 8]);
    expect(current.snapshot.session?.streamIndex).toBe(9);
    expect(current.snapshot.events).toHaveLength(19);
    current.newSession();
    expect(current.snapshot.events).toEqual([]);
    expect(current.snapshot.session?.streamIndex).toBe(0);
  });

  it.each([
    { next: -1 },
    { next: 0.5 },
    { next: Number.POSITIVE_INFINITY },
    { next: Number.MAX_SAFE_INTEGER + 1 },
    { next: 0 },
    { next: 1, endOfLine: false },
  ])("rejects invalid or uncommitted source coverage %j", (meta) => {
    const events = eventsOfLine(linesOf(testTurnFacts(0, "Sunny.", ["d_0"]), "")[0]!, 0, "");
    const last = events.at(-1)!;
    events[events.length - 1] = { ...last, meta: { ...last.meta, ...meta } };
    expect(() => store({ initialEvents: events, initialSession })).toThrow(/Saved `meta.next`/);
  });

  it("rejects history that contradicts its source coverage", () => {
    const converted = convertLegacyEvents(savedV26);
    const extra = eventsOfLine(linesOf(testTurnFacts(1, "Later.", ["later"]), "")[0]!, 7, "");
    expect(() => store({ initialEvents: [...converted, ...extra], initialSession })).toThrow(
      /overlap source lines already covered/,
    );
  });

  it("rejects saved events from before eve 27 instead of advancing the cursor", () => {
    const legacy = [
      {
        data: { message: "sunny." },
        meta: { at: "2026-10-10T00:00:00.000Z", id: "e_0" },
        type: "message.received",
      },
    ];
    expect(() =>
      store({
        // @ts-expect-error Persisted pre-v27 events must fail at the read boundary.
        initialEvents: legacy,
        initialSession: { ...initialSession, streamIndex: 0 },
      }),
    ).toThrow(/saved by eve < 27/);
    const [first] = testTurnFacts(0, "Sunny.", ["d_0"]);
    const unknown = [
      { ...first!, meta: { at: "2026-10-10T00:00:00.000Z", position: { index: 0, line: 0 } } },
      {
        data: {},
        meta: { at: "2026-10-10T00:00:00.000Z", position: { index: 1, line: 0 } },
        type: "turn.started.v26",
      },
    ];
    expect(() =>
      store({
        // @ts-expect-error Unknown persisted event types must fail at the read boundary.
        initialEvents: unknown,
      }),
    ).toThrow(/saved by eve < 27/);
  });

  it("does not adopt or publish an old creation after reset", async () => {
    const created = Promise.withResolvers<void>();
    agent(() => created.promise);
    const current = store();
    const sent = current.send({ message: "sunny." });
    const rejected = expect(sent).rejects.toMatchObject({ name: "AbortError" });
    current.newSession();
    created.resolve();
    await rejected;
    expect(current.snapshot.session).toBeUndefined();
    expect(current.snapshot.status).toBe("idle");
    expect(current.snapshot.events).toEqual([]);
  });

  it("aborts a caller's preparation without aborting a shared prewarm", async () => {
    const created = Promise.withResolvers<void>();
    agent(() => created.promise);
    const current = store({ followWhile: () => false });
    const warm = current.prewarm();
    const controller = new AbortController();
    const sent = current.send({ message: "sunny.", signal: controller.signal });
    const rejected = expect(sent).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    created.resolve();
    await warm;
    expect(current.snapshot.session?.sessionId).toBe("session_1");
  });

  it("shares existing-session preparation and sends while it is pending or fails", async () => {
    const server = agent();
    const serve = vi.mocked(fetch).getMockImplementation()!;
    const preparation = Promise.withResolvers<Response>();
    let preparations = 0;
    vi.mocked(fetch).mockImplementation(async (request, init) => {
      if (init?.method === "POST" && init.body === undefined) {
        preparations += 1;
        return await preparation.promise;
      }
      return await serve(request, init);
    });
    const current = store({ initialSession, followWhile: () => false });
    const warm = current.prewarm();
    const rejected = expect(warm).rejects.toThrow("prepare failed");
    const again = expect(current.prewarm()).rejects.toThrow("prepare failed");

    await current.send({ message: "sunny." });
    expect(server.posts).toEqual(["/eve/v1/session/session_1"]);
    preparation.reject(new Error("prepare failed"));
    await rejected;
    await again;
    expect(preparations).toBe(1);
    expect(current.snapshot.error).toBeUndefined();
    expect(current.snapshot.session?.sessionId).toBe("session_1");
  });

  it("rejects a failed POST and leaves a failed optimistic message", async () => {
    agent();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "offline" }, { status: 500 }));
    const current = store();
    await expect(current.send({ message: "sunny." })).rejects.toThrow();
    expect(current.snapshot.error).toBeInstanceOf(Error);
    expect(current.snapshot.messages[0]?.metadata?.status).toBe("failed");
  });
});

describe("SessionStore Stop during submission", () => {
  it.each([
    { outcome: "cancelled" as const, early: true },
    { outcome: "cancelled" as const, early: false },
    { outcome: "failed" as const, early: true },
    { outcome: "failed" as const, early: false },
  ])(
    "fails an unread message when its turn is $outcome (before receipt: $early)",
    async ({ outcome, early }) => {
      const ended: SessionEvent[] = [
        { type: "delivery.admitted", data: { deliveryId: "d_0" } },
        {
          type: "turn.started",
          data: { turnId: "turn_0", cause: { deliveryId: "d_0" }, follows: null },
        },
        { type: "turn.settled", data: { turnId: "turn_0", outcome } },
        {
          type: "delivery.settled",
          data: { deliveryId: "d_0", turnId: "turn_0", outcome: "failed", reason: "Not read." },
        },
      ];
      const server = agent(async (id) => {
        if (!early || id !== "d_0") return;
        server.append(ended, true);
        await vi.waitFor(() =>
          expect(turn(current.snapshot.view, "turn_0")?.status).toBe("settled"),
        );
      });
      const current = store({ initialSession });
      const sent = await current.send({ message: "Alice asks for the report." });
      if (!early) server.append(ended, true);
      await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
      const failedId = current.snapshot.messages[0]!.id;
      expect(texts(current)).toEqual(["user: Alice asks for the report."]);
      expect(current.snapshot.messages[0]?.metadata).toMatchObject({
        optimistic: true,
        status: "failed",
      });
      await expect(sent.result()).resolves.toMatchObject({ status: "failed" });

      await current.send({ message: "second." });
      server.append(testTurnFacts(1, "Second.", ["d_1"]));
      await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
      expect(current.snapshot.messages[0]?.id).toBe(failedId);
      expect(current.snapshot.messages[0]?.metadata?.status).toBe("failed");
      const second = current.snapshot.messages.filter((message) => message.role === "user")[1];
      expect(second?.metadata?.optimistic).not.toBe(true);
      expect(texts(current)).toEqual([
        "user: Alice asks for the report.",
        "user: second.",
        "assistant: Second.",
      ]);
    },
  );

  it("does not fail an unread steering message until its own delivery settles", async () => {
    const server = agent();
    const current = store({ initialSession });
    await current.send({ message: "first." });
    const first = testTurnFacts(0, "First.", ["d_0"]);
    server.append(first.slice(0, 4));
    await vi.waitFor(() => expect(activeTurn(current.snapshot.view)?.turnId).toBe("turn_0"));
    await current.send({ message: "instead.", turnPolicy: "steer" });
    server.append([{ type: "delivery.admitted", data: { deliveryId: "d_1" } }]);
    server.append(
      first
        .slice(4)
        .map((event): SessionEvent =>
          event.type === "turn.settled"
            ? { ...event, data: { ...event.data, outcome: "cancelled" } }
            : event,
        ),
    );
    await vi.waitFor(() => expect(turn(current.snapshot.view, "turn_0")?.status).toBe("settled"));
    const users = () => current.snapshot.messages.filter((message) => message.role === "user");
    expect(users()[0]?.metadata?.optimistic).not.toBe(true);
    expect(users()[1]?.metadata).toMatchObject({ optimistic: true, status: "submitted" });

    server.append([
      {
        type: "delivery.settled",
        data: { deliveryId: "d_1", turnId: "turn_0", outcome: "failed" },
      },
    ]);
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    expect(users()).toHaveLength(2);
    expect(users()[0]?.metadata?.optimistic).not.toBe(true);
    expect(users()[1]?.metadata).toMatchObject({ optimistic: true, status: "failed" });
  });

  it.each([false, true])(
    "fails an unadmitted message when the session ends (before receipt: %s)",
    async (early) => {
      const ended: SessionEvent[] = [{ type: "session.ended", data: { outcome: "completed" } }];
      const server = agent(async () => {
        if (!early) return;
        server.append(ended);
        await vi.waitFor(() => expect(session(current.snapshot.view).status).toBe("ended"));
      });
      const current = store({ initialSession });
      await current.send({ message: "Alice asks for the report." });
      if (!early) server.append(ended);
      await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
      expect(texts(current)).toEqual(["user: Alice asks for the report."]);
      expect(current.snapshot.messages[0]?.metadata).toMatchObject({
        optimistic: true,
        status: "failed",
      });
    },
  );

  it.each([undefined, initialSession])(
    "waits for the submitted delivery's turn before cancelling (session: %j)",
    async (savedSession) => {
      const receipt = Promise.withResolvers<void>();
      const server = agent(() => receipt.promise);
      const current = store({ initialSession: savedSession });
      const sent = current.send({ message: "sunny." });
      const stopped = current.cancel();
      expect(server.cancellations).toEqual([]);
      receipt.resolve();
      await sent;
      expect(server.cancellations).toEqual([]);
      server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4));
      await expect(stopped).resolves.toMatchObject({
        sessionId: "session_1",
        deliveryId: expect.any(String),
      });
      expect(server.cancellations).toEqual([{ turnId: "turn_0" }]);
      expect(server.reads).toHaveLength(1);
    },
  );

  it("waits for an admitted delivery and still cancels an active turn immediately", async () => {
    const server = agent();
    const current = store({ initialSession });
    await current.send({ message: "sunny." });
    const facts = testTurnFacts(0, "Later.", ["d_0"]);
    server.append(facts.slice(0, 1));
    await vi.waitFor(() => expect(delivery(current.snapshot.view, "d_0")?.status).toBe("admitted"));
    const stopped = current.cancel();
    server.append(facts.slice(1, 4));
    await expect(stopped).resolves.toMatchObject({
      sessionId: "session_1",
      deliveryId: expect.any(String),
    });
    await expect(current.cancel()).resolves.toMatchObject({
      sessionId: "session_1",
      deliveryId: expect.any(String),
    });
    expect(server.cancellations).toEqual([{ turnId: "turn_0" }, { turnId: "turn_0" }]);
  });

  it("cancels a submitted turn without waiting for an unrelated POST receipt", async () => {
    const receipt = Promise.withResolvers<void>();
    const server = agent((id) => (id === "d_1" ? receipt.promise : undefined));
    const current = store({ initialSession });
    const one = current.send({ message: "sunny." });
    const two = current.send({ message: "later.", turnPolicy: "queue" });
    const stopped = current.cancel();
    try {
      await one;
      server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4));
      await expect(stopped).resolves.toMatchObject({
        sessionId: "session_1",
        deliveryId: expect.any(String),
      });
      expect(server.cancellations).toEqual([{ turnId: "turn_0" }]);
    } finally {
      receipt.resolve();
      await two;
    }
  });

  it("waits through preparation without cancelling an unrelated turn", async () => {
    const prepared = Promise.withResolvers<void>();
    const server = agent();
    const current = store({ initialSession });
    current.setCallbacks({
      prepareSend: async (input) => {
        await prepared.promise;
        return input;
      },
    });
    const sent = current.send({ message: "sunny." });
    const stopped = current.cancel();
    prepared.resolve();
    await sent;
    server.append(testTurnFacts(0, "Other.", ["other"]).slice(0, 4));
    await vi.waitFor(() => expect(turn(current.snapshot.view, "turn_0")?.status).toBe("running"));
    expect(server.cancellations).toEqual([]);
    server.append(testTurnFacts(0, "Other.", ["other"]).slice(4));
    server.append(testTurnFacts(1, "Later.", ["d_0"]).slice(0, 4));
    await expect(stopped).resolves.toMatchObject({
      sessionId: "session_1",
      deliveryId: expect.any(String),
    });
    expect(server.cancellations).toEqual([{ turnId: "turn_1" }]);
  });

  it.each(["ignored", "completed"] as const)(
    "does not cancel later work when the submitted delivery is already %s",
    async (outcome) => {
      const server = agent();
      const current = store({ initialSession });
      await current.send({ message: "sunny." });
      const stopped = current.cancel();
      server.append(
        outcome === "ignored"
          ? [
              { type: "delivery.admitted", data: { deliveryId: "d_0" } },
              { type: "delivery.settled", data: { deliveryId: "d_0", outcome: "ignored" } },
              ...testTurnFacts(0, "Other.", ["other"]).slice(0, 4),
            ]
          : [
              ...testTurnFacts(0, "Done.", ["d_0"]),
              ...testTurnFacts(1, "Other.", ["other"]).slice(0, 4),
            ],
        true,
      );
      await expect(stopped).resolves.toMatchObject({
        sessionId: "session_1",
        deliveryId: expect.any(String),
      });
      expect(server.cancellations).toEqual([{ turnId: null }]);
    },
  );

  it("aborts a deferred Stop on reset without cancelling the next session", async () => {
    const server = agent();
    const current = store({ initialSession });
    await current.send({ message: "sunny." });
    const stopped = current.cancel();
    const aborted = expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    current.newSession();
    await aborted;
    await current.send({ message: "again." });
    server.append(testTurnFacts(0, "Again.", ["d_1"]));
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    expect(server.cancellations).toEqual([]);
  });

  it("rejects a deferred Stop when observation fails", async () => {
    const server = agent();
    const current = store({ initialSession });
    await current.send({ message: "sunny." });
    const stopped = current.cancel();
    const failed = expect(stopped).rejects.toThrow("observer failed");
    current.setCallbacks({
      onEvent: () => {
        throw new Error("observer failed");
      },
    });
    server.append(testTurnFacts(0, "Other.", ["other"]).slice(0, 4), true);
    await failed;
    expect(server.cancellations).toEqual([]);
  });

  it("does not arm an idle Stop for a future submission", async () => {
    const server = agent();
    const current = store({ initialSession });
    const stop = await current.cancel();
    await expect(stop.result()).resolves.toMatchObject({ status: "completed" });
    expect(server.cancellations).toEqual([{ turnId: null }]);
    const before = [...server.cancellations];
    await current.send({ message: "sunny." });
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    expect(server.cancellations).toEqual(before);
  });
});

describe("SessionStore committed snapshots", () => {
  it("does not apply an old ending after its observer starts a fresh session", async () => {
    const server = agent();
    const current = store();
    await current.send({ message: "Review the report." });
    await vi.waitFor(() => expect(server.reads).toHaveLength(1));
    const reset = vi.fn();
    current.setCallbacks({
      onEvent: (event) => {
        if (event.type === "session.ended") {
          current.newSession();
          reset();
        }
      },
    });
    server.append(
      [
        ...testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4),
        {
          type: "session.ended",
          data: {
            outcome: "failed",
            error: { code: "session_stranded", message: "Earlier session unavailable." },
          },
        },
      ],
      true,
    );
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    expect(current.snapshot.session).toBeUndefined();
    expect(current.snapshot.error).toBeUndefined();
    expect(current.snapshot.events).toEqual([]);
  });

  it("stops showing a retired session as busy when its last rows could not be settled", async () => {
    const server = agent();
    const current = store();
    await current.send({ message: "Review the report." });
    server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4));
    await vi.waitFor(() => expect(activeTurn(current.snapshot.view)?.turnId).toBe("turn_0"));
    server.append(
      [
        { type: "model.settled", data: { runId: "run_0", outcome: "completed" } },
        {
          type: "interaction.opened",
          data: {
            interactionId: "question",
            subject: { turnId: "turn_0" },
            request: { kind: "question", prompt: "Which report?" },
          },
        },
        {
          type: "session.ended",
          data: {
            outcome: "failed",
            error: { code: "session_stranded", message: "Session unavailable." },
          },
        },
      ],
      true,
    );
    await vi.waitFor(() => expect(current.snapshot.error?.message).toBe("Session unavailable."));
    expect(current.snapshot.status).toBe("idle");
    expect(activeTurn(current.snapshot.view)).toBeUndefined();
    expect(openInteractions(current.snapshot.view)).toEqual([]);
  });

  it("reports a mid-line stream failure without exposing the unfinished line", async () => {
    const server = agent();
    const current = store();
    await current.send({ message: "sunny." });
    const before = current.snapshot;
    current.setCallbacks({
      onEvent: (event) => {
        if (event.type === "turn.started") throw new Error("observer failed");
      },
    });
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]).slice(0, 4), true);
    await vi.waitFor(() => expect(current.snapshot.error).toBeInstanceOf(Error));
    expect(current.snapshot.error?.message).toBe("observer failed");
    expect(current.snapshot.view).toBe(before.view);
    expect(current.snapshot.events).toEqual(before.events);
    current.setCallbacks({});
    const sending = current.send({ message: "again." });
    expect(texts(current)).toEqual(["user: sunny.", "user: again."]);
    await sending;
    await vi.waitFor(() => expect(turn(current.snapshot.view, "turn_0")?.status).toBe("running"));
    expect(current.snapshot.events.filter((event) => event.type === "turn.started")).toHaveLength(
      1,
    );
  });

  it("publishes cancellation and its session failure together, retaining previous table snapshots", async () => {
    const server = agent();
    const current = store();
    await current.send({ message: "sunny." });
    server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4));
    await vi.waitFor(() => expect(turn(current.snapshot.view, "turn_0")?.status).toBe("running"));
    const before = current.snapshot;
    const seen: { cancelled: boolean; failed: boolean }[] = [];
    current.subscribe(() =>
      seen.push({
        cancelled: turn(current.snapshot.view, "turn_0")?.outcome === "cancelled",
        failed: current.snapshot.error !== undefined,
      }),
    );
    server.append(
      [
        { data: { outcome: "interrupted", runId: "run_0" }, type: "model.settled" },
        {
          data: { deliveryId: "d_0", outcome: "handled", turnId: "turn_0" },
          type: "delivery.settled",
        },
        { data: { outcome: "cancelled", turnId: "turn_0" }, type: "turn.settled" },
        {
          data: {
            cause: { turnId: "turn_0" },
            error: { code: "MODEL_FAILED", message: "boom" },
            outcome: "failed",
          },
          type: "session.ended",
        },
      ],
      true,
    );
    await vi.waitFor(() => expect(current.snapshot.error?.message).toBe("boom"));
    expect(seen.filter(({ cancelled, failed }) => cancelled && !failed)).toEqual([]);
    expect(turn(before.view, "turn_0")?.status).toBe("running");
  });
});

describe("SessionStore with a follow predicate", () => {
  it("reopens the stream from the folded line cursor on the next send", async () => {
    const server = agent();
    const current = store({ followWhile: () => false });
    await current.send({ message: "sunny." });
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    await vi.waitFor(() => expect(server.reads[0]?.signal?.aborted).toBe(true));
    await current.send({ message: "again." });
    server.append(testTurnFacts(1, "Again.", ["d_1"]));
    await vi.waitFor(() => expect(server.reads[1]?.signal?.aborted).toBe(true));
    expect(server.reads.map((read) => read.start)).toEqual([0, 8]);
    expect(texts(current)).toEqual([
      "user: sunny.",
      "assistant: Sunny.",
      "user: again.",
      "assistant: Again.",
    ]);
  });

  it("keeps following a task that outlives its turn, then closes when the task ends", async () => {
    const server = agent();
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]).slice(0, 4));
    server.append(
      [
        {
          type: "call.requested",
          data: {
            callId: "call_task",
            capability: { kind: "agent", name: "helper" },
            input: {},
            owner: { runId: "run_0" },
          },
        },
        {
          type: "task.started",
          data: {
            taskId: "task_1",
            kind: "agent",
            name: "helper",
            startedBy: { callId: "call_task" },
          },
        },
        { type: "call.started", data: { callId: "call_task", taskId: "task_1" } },
        { type: "model.settled", data: { runId: "run_0", outcome: "completed" } },
        { type: "turn.settled", data: { turnId: "turn_0", outcome: "completed" } },
        {
          type: "delivery.settled",
          data: { deliveryId: "d_0", turnId: "turn_0", outcome: "handled" },
        },
      ],
      true,
    );
    const current = store({ followWhile: (view) => !idle(view), initialSession });
    await current.resume();
    expect(server.reads[0]?.signal?.aborted).toBe(false);
    server.append(
      [
        {
          type: "call.settled",
          data: { callId: "call_task", outcome: "completed", output: "done" },
        },
        { type: "task.ended", data: { taskId: "task_1", outcome: "completed" } },
      ],
      true,
    );
    await vi.waitFor(() => expect(server.reads[0]?.signal?.aborted).toBe(true));
    expect(current.snapshot.status).toBe("idle");
  });

  it("keeps idle replay attached while a control receipt is pending", async () => {
    const release = Promise.withResolvers<void>();
    const server = agent(() => release.promise);
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    const current = store({ followWhile: () => false, initialSession });
    const pending = current.compact();
    try {
      await current.resume();
      expect(server.reads[0]?.signal?.aborted).toBe(false);
      release.resolve();
      const receipt = await pending;
      server.append(
        [
          {
            type: "delivery.admitted",
            data: { deliveryId: receipt.deliveryId, source: { control: "compact" } },
          },
          {
            type: "delivery.settled",
            data: { deliveryId: receipt.deliveryId, outcome: "applied" },
          },
        ],
        true,
      );
      await expect(receipt.result()).resolves.toMatchObject({ status: "completed" });
      await vi.waitFor(() => expect(server.reads[0]?.signal?.aborted).toBe(true));
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  it("closes after resuming a settled session", async () => {
    const server = agent();
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    const current = store({ followWhile: () => false, initialSession });
    await current.resume();
    expect(current.snapshot.status).toBe("idle");
    expect(server.reads[0]?.signal?.aborted).toBe(true);
  });

  it("reopens from its own view after an independent session reader advances", async () => {
    const server = agent();
    const session = new Client({ baseUrl: "https://eve.test" }).sessions.attach("session_1", {
      streamIndex: 0,
    });
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    const current = store({ followWhile: () => false, session });
    await current.resume();
    server.append(testTurnFacts(1, "Arrived while closed.", ["d_1"]));
    for await (const _event of session.stream({ follow: false, startIndex: 0 })) {
      /* bounded independent read */
    }
    expect(session.state.streamIndex).toBe(server.log.length);
    expect(current.snapshot.status).toBe("idle");
    const compacting = current.compact();
    expect(current.snapshot.status).toBe("busy");
    const receipt = await compacting;
    server.append(
      [
        {
          type: "delivery.admitted",
          data: { deliveryId: receipt.deliveryId, source: { control: "compact" } },
        },
        { type: "delivery.settled", data: { deliveryId: receipt.deliveryId, outcome: "applied" } },
      ],
      true,
    );
    await receipt.result();
    expect(texts(current)).toContain("assistant: Arrived while closed.");
  });

  it("keeps a paused turn's stream attached through unrelated delivery settlements", async () => {
    const server = agent();
    appendPersonWait(server);
    const current = store({
      followWhile: (view) => !idle(view) || activeTurn(view) !== undefined,
      initialSession,
    });
    await current.resume();
    server.append(
      [
        { type: "delivery.admitted", data: { deliveryId: "control" } },
        { type: "delivery.settled", data: { deliveryId: "control", outcome: "applied" } },
      ],
      true,
    );
    await vi.waitFor(() =>
      expect(delivery(current.snapshot.view, "control")?.status).toBe("settled"),
    );
    expect(activeTurn(current.snapshot.view)?.turnId).toBe("turn_0");
    expect(current.snapshot.status).toBe("idle");
    expect(server.reads[0]?.signal?.aborted).toBe(false);
  });

  it("stays busy for an unseen receipt and an answer while a person-wait turn is open", async () => {
    const server = agent();
    appendPersonWait(server);
    const current = store({ initialSession });
    await current.resume();
    expect(current.snapshot.status).toBe("idle");
    current.follow({ sessionId: "session_1", deliveryId: "other" });
    expect(current.snapshot.status).toBe("busy");
    server.append(
      [
        { type: "delivery.admitted", data: { deliveryId: "other" } },
        { type: "delivery.settled", data: { deliveryId: "other", outcome: "applied" } },
      ],
      true,
    );
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));

    const answering = current.send({ answers: [{ interactionId: "question", text: "This." }] });
    expect(current.snapshot.status).toBe("busy");
    const { deliveryId } = await answering;
    server.append(
      [
        { type: "delivery.admitted", data: { deliveryId } },
        {
          type: "response.submitted",
          data: {
            responseId: "r_0",
            interactionId: "question",
            deliveryId,
            value: { text: "This." },
          },
        },
        {
          type: "model.requested",
          data: { owner: { turnId: "turn_0" }, runId: "run_1" },
          scope: { runId: "run_1", turnId: "turn_0" },
        },
        { type: "delivery.settled", data: { deliveryId, outcome: "handled", turnId: "turn_0" } },
      ],
      true,
    );
    await vi.waitFor(() =>
      expect(delivery(current.snapshot.view, deliveryId)?.status).toBe("settled"),
    );
    expect(current.snapshot.status).toBe("busy");
  });

  it("follows another store's receipt across an idle pre-admission tail and settles", async () => {
    const server = agent();
    const sender = store({ initialSession });
    const observer = store({ initialSession, followWhile: () => false });
    const receipt = await sender.send({ message: "sunny." });
    observer.follow(receipt);
    await vi.waitFor(() => expect(server.reads).toHaveLength(2));
    expect(observer.snapshot.status).toBe("busy");
    expect(observer.snapshot.session?.streamIndex).toBe(0);
    server.append(testTurnFacts(0, "Sunny.", [receipt.deliveryId]));
    await vi.waitFor(() => expect(observer.snapshot.status).toBe("idle"));
    expect(observer.snapshot.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(server.reads[1]?.signal?.aborted).toBe(true);
  });

  it("keeps unseen receipts across a disconnect and a preceding settled delivery", async () => {
    const server = agent();
    const current = store({ initialSession, followWhile: () => false });
    current.follow({ sessionId: "session_1", deliveryId: "a" });
    current.follow({ sessionId: "session_1", deliveryId: "b" });
    current.follow({ sessionId: "session_1", deliveryId: "b" });
    await vi.waitFor(() => expect(server.reads).toHaveLength(1));
    server.append(testTurnFacts(0, "A.", ["a"]));
    await vi.waitFor(() => expect(delivery(current.snapshot.view, "a")?.status).toBe("settled"));
    expect(current.snapshot.status).toBe("busy");
    expect(server.reads[0]?.signal?.aborted).toBe(false);
    detachSessionStore(current);
    attachSessionStore(current);
    await vi.waitFor(() => expect(server.reads).toHaveLength(2));
    expect(current.snapshot.status).toBe("busy");
    server.append(testTurnFacts(1, "B.", ["b"]));
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
  });

  it("resumes following an active stream when reattached", async () => {
    const server = agent();
    const current = store({ initialSession });
    await current.resume();
    server.append(testTurnFacts(0, "Sunny.", ["other"]).slice(0, 4), true);
    await vi.waitFor(() => expect(current.snapshot.status).toBe("busy"));
    detachSessionStore(current);
    attachSessionStore(current);
    await vi.waitFor(() => expect(server.reads).toHaveLength(2));
    server.append(testTurnFacts(0, "Sunny.", ["other"]).slice(4), true);
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
  });

  it("retries a followed receipt after a non-retryable stream error", async () => {
    const server = agent();
    const current = store({ initialSession, followWhile: () => false });
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    current.follow({ sessionId: "session_1", deliveryId: "d_0" });
    await vi.waitFor(() => expect(current.snapshot.error).toBeDefined());
    expect(current.snapshot.status).toBe("busy");
    current.follow({ sessionId: "session_1", deliveryId: "d_0" });
    await vi.waitFor(() => expect(server.reads).toHaveLength(1));
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    expect(current.snapshot.error).toBeUndefined();
  });

  it.each(["follow", "resume"] as const)(
    "reopens a failed %s stream once when onError follows the receipt again",
    async (operation) => {
      const server = agent();
      const current = store({ initialSession, followWhile: () => false });
      const receipt = { sessionId: "session_1", deliveryId: "d_0" };
      vi.mocked(fetch).mockResolvedValueOnce(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );
      const onError = vi.fn(() => current.follow(receipt));
      current.setCallbacks({ onError });
      if (operation === "resume")
        await expect(current.resume()).rejects.toMatchObject({ status: 403 });
      else current.follow(receipt);
      await vi.waitFor(() => expect(server.reads).toHaveLength(1));
      server.append(testTurnFacts(0, "Sunny.", [receipt.deliveryId]));
      await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
      expect(onError).toHaveBeenCalledOnce();
      expect(current.snapshot.error).toBeUndefined();
      expect(server.reads[0]?.signal?.aborted).toBe(true);
    },
  );

  it.each(["completed", "failed"] as const)(
    "does not complete historical %s work again when following its settled receipt",
    async (outcome) => {
      const server = agent();
      server.append([
        ...testTurnFacts(0, "Earlier.", ["old"]).map((event): SessionEvent =>
          event.type === "turn.settled" && outcome === "failed"
            ? {
                ...event,
                data: {
                  ...event.data,
                  outcome: "failed",
                  error: { code: "EARLIER", message: "Earlier failure" },
                },
              }
            : event,
        ),
        ...(outcome === "failed"
          ? ([
              {
                type: "session.ended",
                data: {
                  outcome: "failed",
                  error: { code: "SESSION_FAILED", message: "Session unavailable." },
                },
              },
            ] as const)
          : []),
      ]);
      const current = store({ initialSession, followWhile: () => false });
      const onFinish = vi.fn();
      const onError = vi.fn();
      current.setCallbacks({
        onFinish,
        onError,
        onEvent: (event) => {
          if (event.type === "turn.settled")
            current.follow({ sessionId: "session_1", deliveryId: "old" });
        },
      });
      await current.resume();
      const existingError = current.snapshot.error;
      if (outcome === "failed") expect(existingError).toBeDefined();
      expect(onFinish).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      const reads = server.reads.length;
      current.follow({ sessionId: "session_1", deliveryId: "old" });
      expect(server.reads).toHaveLength(reads);
      expect(onFinish).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(current.snapshot.error).toBe(existingError);
    },
  );

  it("replays a partial committed line even when another reader advanced the handle", async () => {
    const server = agent();
    const session = new Client({ baseUrl: "https://eve.test" }).sessions.attach("session_1");
    const receipt = await session.send("sunny.");
    const facts = testTurnFacts(0, "Sunny.", [receipt.deliveryId]);
    const at = "2026-10-10T00:00:00.000Z";
    server.append(facts, true);
    const saved = eventsOfLine(linesOf(facts, at)[0]!, 0, at).slice(0, 2);
    const current = store({ session, initialEvents: saved, followWhile: () => false });
    await receipt.result();
    const received = vi.fn();
    current.setCallbacks({ onEvent: received });
    current.follow(receipt);
    await vi.waitFor(() => expect(current.snapshot.session?.streamIndex).toBe(1));
    expect(server.reads.at(-1)?.start).toBe(0);
    expect(current.snapshot.events).toHaveLength(facts.length);
    expect(received).toHaveBeenCalledTimes(facts.length - saved.length);
    expect(current.snapshot.status).toBe("idle");
  });

  it("rejects receipts without a matching session and ignores already settled or unknown ids only after settlement", async () => {
    const server = agent();
    expect(() => store().follow({ sessionId: "session_1", deliveryId: "d_0" })).toThrow();
    const current = store({ initialSession, followWhile: () => false });
    expect(() => current.follow({ sessionId: "other", deliveryId: "d_0" })).toThrow();
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    await current.resume();
    const count = server.reads.length;
    current.follow({ sessionId: "session_1", deliveryId: "d_0" });
    expect(current.snapshot.status).toBe("idle");
    expect(server.reads).toHaveLength(count);
    current.follow({ sessionId: "session_1", deliveryId: "unknown" });
    expect(current.snapshot.status).toBe("busy");
    await vi.waitFor(() => expect(server.reads).toHaveLength(count + 1));
    current.newSession();
    expect(current.snapshot.status).toBe("idle");
  });

  it.each(["live", "historical"] as const)(
    "clears unseen receipts on a %s session end without replaying errors",
    async (timing) => {
      const server = agent();
      const current = store({ initialSession, followWhile: () => false });
      const receipt = { sessionId: "session_1", deliveryId: "not-admitted" };
      const onError = vi.fn(() => {
        if (onError.mock.calls.length < 3) current.follow(receipt);
      });
      current.setCallbacks({ onError });
      if (timing === "live") {
        current.follow(receipt);
        await vi.waitFor(() => expect(server.reads).toHaveLength(1));
      }
      server.append([
        {
          type: "session.ended",
          data: {
            outcome: "failed",
            error: { code: "SESSION_FAILED", message: "Session unavailable." },
          },
        },
      ]);
      if (timing === "historical") current.follow(receipt);
      await vi.waitFor(() => expect(current.snapshot.error?.message).toBe("Session unavailable."));
      expect(current.snapshot.status).toBe("idle");
      const error = current.snapshot.error;
      current.follow({ sessionId: "session_1", deliveryId: "not-admitted-later" });
      expect(current.snapshot.status).toBe("idle");
      expect(onError).toHaveBeenCalledTimes(timing === "live" ? 1 : 0);
      expect(current.snapshot.error).toBe(error);
    },
  );

  it("publishes only committed lines when a receipt arrives inside a line", async () => {
    const server = agent();
    let keepFollowing = true;
    const current = store({ initialSession, followWhile: () => keepFollowing });
    const before = current.snapshot;
    current.setCallbacks({
      onEvent: (event) => {
        if (event.type === "delivery.admitted") {
          current.follow({ sessionId: "session_1", deliveryId: "d_0" });
          expect(current.snapshot.view).toBe(before.view);
          expect(current.snapshot.events).toBe(before.events);
          expect(current.snapshot.status).toBe("busy");
        }
      },
    });
    await current.resume();
    keepFollowing = false;
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]), true);
    await vi.waitFor(() => expect(current.snapshot.session?.streamIndex).toBe(1));
    expect(current.snapshot.status).toBe("idle");
  });

  it("closes on an interaction wait with the !idle predicate", async () => {
    const server = agent();
    appendPersonWait(server);
    const current = store({ initialSession, followWhile: (view) => !idle(view) });
    await current.resume();
    expect(idle(current.snapshot.view)).toBe(true);
    expect(server.reads[0]?.signal?.aborted).toBe(true);
  });

  it("does not publish an idle fold inside a commit that ends with queued work", async () => {
    const server = agent();
    server.append(testTurnFacts(0, "Later.", ["asked"]).slice(0, 4));
    const current = store({ initialSession });
    await current.resume();
    const statuses: string[] = [];
    current.subscribe(() => statuses.push(current.snapshot.status));
    server.append(
      [...personWait, { type: "delivery.admitted", data: { deliveryId: "d_1" } }],
      true,
    );
    await vi.waitFor(() => expect(delivery(current.snapshot.view, "d_1")?.status).toBe("admitted"));
    expect(statuses).not.toContain("idle");
    expect(current.snapshot.status).toBe("busy");
  });

  it("closes during active work when the predicate declines, retaining the busy snapshot", async () => {
    const server = agent();
    const current = store({ initialSession, followWhile: () => false });
    server.append(testTurnFacts(0, "Sunny.", ["other"]).slice(0, 4), true);
    await current.resume();
    expect(current.snapshot.status).toBe("busy");
    expect(server.reads[0]?.signal?.aborted).toBe(true);
  });
});
