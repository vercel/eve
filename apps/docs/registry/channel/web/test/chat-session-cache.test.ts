import assert from "node:assert/strict";
import { test } from "node:test";
import { EveAgentStore, type MessageStreamEvent } from "eve/client";
import { chatMessageReducer } from "../lib/chat-message-reducer.ts";
import { createChatSessionCache, type SavedChatSession } from "../lib/chat-session-cache.ts";

const events: readonly MessageStreamEvent[] = [
  {
    type: "message.received",
    meta: { id: "event-1", at: "2026-09-20T00:00:00.000Z" },
    data: { message: "Hello", sequence: 0, turnId: "turn-1" },
  },
  {
    type: "message.completed",
    meta: { id: "event-2", at: "2026-09-20T00:00:01.000Z" },
    data: {
      message: "Welcome back",
      finishReason: "stop",
      sequence: 1,
      stepIndex: 0,
      turnId: "turn-1",
    },
  },
];

test("returning to a session renders cached messages before any stream request", () => {
  const cache = createChatSessionCache();
  const session = { sessionId: "wrun_FIRST", streamIndex: events.length };
  cache.set({ events, session });
  cache.set({ events: [], session: { sessionId: "wrun_SECOND", streamIndex: 0 } });
  const saved = cache.get(session.sessionId)!;
  const restored = new EveAgentStore({
    host: "http://localhost:3000",
    initialEvents: saved.events,
    initialSession: saved.session,
    reducer: chatMessageReducer(),
  });
  assert.deepEqual(restored.snapshot.session, session);
  assert.deepEqual(
    restored.snapshot.data.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.ok(
    restored.snapshot.data.messages[1].parts.some(
      (part) => part.type === "text" && part.text === "Welcome back",
    ),
  );
  assert.equal(cache.get("wrun_SECOND")?.events.length, 0);
  assert.equal(cache.get("wrun_UNKNOWN"), undefined);
});

test("keeps recently used session snapshots and bounds retained histories", () => {
  const cache = createChatSessionCache(2);
  const save = (id: string) =>
    cache.set({ events, session: { sessionId: id, streamIndex: events.length } });
  save("first");
  save("second");
  save("first");
  save("third");
  assert.ok(cache.get("first"));
  assert.equal(cache.get("second"), undefined);
  assert.ok(cache.get("third"));
  cache.set({
    events: Array.from({ length: 10_001 }, () => events[0]),
    session: { sessionId: "first", streamIndex: 10_001 },
  });
  assert.equal(cache.get("first"), undefined);
});

test("hover and click share a snapshot request and hydrate before navigation", async () => {
  const cache = createChatSessionCache();
  const snapshot = { events, session: { sessionId: "target", streamIndex: events.length } };
  const deferred = Promise.withResolvers<typeof snapshot>();
  let reads = 0;
  const read = () => {
    reads++;
    return deferred.promise;
  };
  const hover = cache.load("target", read);
  const click = cache.load("target", read);
  assert.equal(hover, click);
  assert.equal(reads, 1);
  assert.equal(cache.get("target"), undefined);
  deferred.resolve(snapshot);
  assert.equal(await click, snapshot);
  assert.equal(cache.get("target"), snapshot);
  assert.equal(await cache.load("target", read), snapshot);
  assert.equal(reads, 1);
});

test("failed prefetches can retry and late snapshots cannot replace newer live events", async () => {
  const cache = createChatSessionCache();
  await assert.rejects(
    cache.load("target", async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  const old = { events: events.slice(0, 1), session: { sessionId: "target", streamIndex: 1 } };
  const fresh = { events, session: { sessionId: "target", streamIndex: 2 } };
  const deferred = Promise.withResolvers<typeof old>();
  const retry = cache.load("target", () => deferred.promise);
  cache.set(fresh);
  deferred.resolve(old);
  assert.equal(await retry, fresh);
  assert.equal(cache.get("target"), fresh);
});

test("oversized snapshots are available for navigation without entering the retained cache", async () => {
  const cache = createChatSessionCache();
  const snapshot = {
    events: Array.from({ length: 10_001 }, () => events[0]),
    session: { sessionId: "large", streamIndex: 10_001 },
  };
  assert.equal(await cache.load("large", async () => snapshot), snapshot);
  assert.equal(cache.get("large"), undefined);
});

test("identity changes discard an in-flight snapshot", async () => {
  const cache = createChatSessionCache();
  let finish!: (value: SavedChatSession) => void;
  const pending = cache.load(
    "wrun_old",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  cache.clear();
  finish({ session: { sessionId: "wrun_old", streamIndex: 0 }, events: [] } as SavedChatSession);
  await assert.rejects(pending, /identity changed/);
  assert.equal(cache.get("wrun_old"), undefined);
});
