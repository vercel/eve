import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detachEveAgentStore,
  EveAgentStore,
  type EveAgentStoreInit,
} from "#client/eve-agent-store.js";
import { testTurnFacts } from "#internal/testing/events.js";
import { eventsOfLine, linesOf } from "#protocol/session-lines.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_TAIL_INDEX_HEADER,
  EVE_STREAM_VERSION_HEADER,
} from "#protocol/session-http.js";
import type { SessionEvent } from "#protocol/session-event.js";

const stores: EveAgentStore[] = [];
function store(options: EveAgentStoreInit = {}) {
  const result = new EveAgentStore({ host: "https://eve.test", ...options });
  stores.push(result);
  return result;
}
afterEach(() => {
  for (const current of stores.splice(0)) detachEveAgentStore(current);
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
  let activeTurnId: string | undefined;
  const encoder = new TextEncoder();
  const append = (events: readonly SessionEvent[], together = false) => {
    for (const event of events) {
      if (event.type === "turn.started") activeTurnId = event.data.turnId;
      if (event.type === "turn.settled" || event.type === "session.ended") activeTurnId = undefined;
    }
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
        const body = JSON.parse(String(init?.body)) as { turnId?: string };
        cancellations.push(body);
        return Response.json(
          activeTurnId !== undefined && (body.turnId === undefined || body.turnId === activeTurnId)
            ? { ok: true, sessionId: "session_1", status: "accepted" }
            : { ok: true, status: "no_active_turn" },
        );
      }
      if (/\/(clear|compact|reset)$/.test(path.pathname))
        return Response.json({ status: "accepted" });
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
function texts(current: EveAgentStore) {
  return current.snapshot.messages.map(
    (message) =>
      `${message.role}: ${message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")}`,
  );
}
const initialSession = { sessionId: "session_1", streamIndex: 0 };

describe("EveAgentStore acceptance and observation", () => {
  it("resolves a send at acceptance, then observes its turn on the one session stream", async () => {
    const server = agent();
    const current = store();
    const finished = vi.fn();
    current.setCallbacks({ onFinish: finished });
    const sent = current.send({ message: "sunny." });
    const echoId = current.snapshot.messages[0]!.id;
    expect(texts(current)).toEqual(["user: sunny."]);
    await expect(sent).resolves.toEqual({ deliveryId: "d_0", sessionId: "session_1" });
    expect(finished).not.toHaveBeenCalled();
    expect(current.snapshot.status).toBe("busy");
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    expect(texts(current)).toEqual(["user: sunny.", "assistant: Sunny."]);
    expect(current.snapshot.messages[0]!.id).toBe(echoId);
    expect(finished).toHaveBeenCalledOnce();
    expect(server.reads).toHaveLength(1);
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
    created.resolve();
    expect(await one).toEqual({ deliveryId: "d_0", sessionId: "session_1" });
    expect(await two).toEqual({ deliveryId: "d_1", sessionId: "session_1" });
    expect(server.posts).toEqual(["/eve/v1/session", "/eve/v1/session/session_1"]);
    expect(server.reads).toHaveLength(1);
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

  it("does not adopt or publish an old creation after reset", async () => {
    const created = Promise.withResolvers<void>();
    agent(() => created.promise);
    const current = store();
    const sent = current.send({ message: "sunny." });
    const rejected = expect(sent).rejects.toMatchObject({ name: "AbortError" });
    current.reset();
    created.resolve();
    await rejected;
    expect(current.snapshot.session).toBeUndefined();
    expect(current.snapshot.status).toBe("idle");
    expect(current.snapshot.events).toEqual([]);
  });

  it("aborts a caller's preparation without aborting a shared prewarm", async () => {
    const created = Promise.withResolvers<void>();
    agent(() => created.promise);
    const current = store({ followIdle: false });
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

  it("rejects a failed POST and leaves a failed optimistic message", async () => {
    agent();
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "offline" }, { status: 500 }));
    const current = store();
    await expect(current.send({ message: "sunny." })).rejects.toThrow();
    expect(current.snapshot.error).toBeInstanceOf(Error);
    expect(current.snapshot.messages[0]?.metadata?.status).toBe("failed");
  });
});

describe("EveAgentStore Stop during submission", () => {
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
      await expect(stopped).resolves.toEqual({ sessionId: "session_1", status: "accepted" });
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
    await vi.waitFor(() => expect(current.snapshot.view.deliveries.d_0?.status).toBe("admitted"));
    const stopped = current.cancel();
    server.append(facts.slice(1, 4));
    await expect(stopped).resolves.toEqual({ sessionId: "session_1", status: "accepted" });
    await expect(current.cancel()).resolves.toEqual({ sessionId: "session_1", status: "accepted" });
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
      await expect(stopped).resolves.toEqual({ sessionId: "session_1", status: "accepted" });
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
    await vi.waitFor(() => expect(current.snapshot.view.turns.turn_0?.status).toBe("running"));
    expect(server.cancellations).toEqual([]);
    server.append(testTurnFacts(0, "Other.", ["other"]).slice(4));
    server.append(testTurnFacts(1, "Later.", ["d_0"]).slice(0, 4));
    await expect(stopped).resolves.toEqual({ sessionId: "session_1", status: "accepted" });
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
      await expect(stopped).resolves.toEqual({ status: "no_active_turn" });
      expect(server.cancellations).toEqual([]);
    },
  );

  it("aborts a deferred Stop on reset without cancelling the next session", async () => {
    const server = agent();
    const current = store({ initialSession });
    await current.send({ message: "sunny." });
    const stopped = current.cancel();
    const aborted = expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    current.reset();
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
    await expect(current.cancel()).resolves.toEqual({ status: "no_active_turn" });
    const before = [...server.cancellations];
    await current.send({ message: "sunny." });
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    await vi.waitFor(() => expect(current.snapshot.status).toBe("idle"));
    expect(server.cancellations).toEqual(before);
  });
});

describe("EveAgentStore committed snapshots", () => {
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
    expect(current.snapshot.events).toBe(before.events);
  });

  it("publishes cancellation and its session failure together, retaining previous table snapshots", async () => {
    const server = agent();
    const current = store();
    await current.send({ message: "sunny." });
    server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4));
    await vi.waitFor(() => expect(current.snapshot.view.turns.turn_0?.status).toBe("running"));
    const before = current.snapshot;
    const seen: { cancelled: boolean; failed: boolean }[] = [];
    current.subscribe(() =>
      seen.push({
        cancelled: current.snapshot.view.turns.turn_0?.outcome === "cancelled",
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
    expect(before.view.turns.turn_0?.status).toBe("running");
  });
});

describe("EveAgentStore with followIdle disabled", () => {
  it("reopens the stream from the folded line cursor on the next send", async () => {
    const server = agent();
    const current = store({ followIdle: false });
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
    const current = store({ followIdle: false, initialSession });
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

  it("closes after resuming a settled session", async () => {
    const server = agent();
    server.append(testTurnFacts(0, "Sunny.", ["d_0"]));
    const current = store({ followIdle: false, initialSession });
    await current.resume();
    expect(current.snapshot.status).toBe("idle");
    expect(server.reads[0]?.signal?.aborted).toBe(true);
  });

  it("keeps a paused turn's stream attached through unrelated delivery settlements", async () => {
    const server = agent();
    server.append(testTurnFacts(0, "Later.", ["d_0"]).slice(0, 4));
    server.append(
      [
        { type: "model.settled", data: { runId: "run_0", outcome: "completed" } },
        {
          type: "interaction.opened",
          data: {
            interactionId: "question",
            request: { kind: "question", prompt: "Which?" },
            subject: { turnId: "turn_0" },
          },
        },
        {
          type: "turn.paused",
          data: { turnId: "turn_0", awaiting: [{ interactionId: "question" }] },
        },
        {
          type: "delivery.settled",
          data: { deliveryId: "d_0", outcome: "awaiting-input", turnId: "turn_0" },
        },
      ],
      true,
    );
    const current = store({ followIdle: false, initialSession });
    await current.resume();
    server.append(
      [
        { type: "delivery.admitted", data: { deliveryId: "control" } },
        { type: "delivery.settled", data: { deliveryId: "control", outcome: "applied" } },
      ],
      true,
    );
    await vi.waitFor(() =>
      expect(current.snapshot.view.deliveries.control?.status).toBe("settled"),
    );
    expect(current.snapshot.status).toBe("busy");
    expect(server.reads[0]?.signal?.aborted).toBe(false);
  });
});
