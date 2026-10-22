import test from "node:test";
import assert from "node:assert/strict";
import { captureSessions } from "./measurements/events.mjs";

const event = (type, id, second, data = {}) => ({
  type,
  meta: { id, at: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z` },
  data,
});

test("deduplicates repeated captures without losing later events", () => {
  const start = event("turn.started", "start", 0, { turnId: "turn" });
  const later = event("turn.completed", "completed", 1, { turnId: "turn" });
  const capture = captureSessions([
    { sessionId: "session", events: [start, structuredClone(start)] },
    { sessionId: "session", events: [structuredClone(start), later] },
  ]);
  assert.deepEqual(capture.bySession.get("session"), [start, later]);
});

test("rejects malformed or ambiguous capture identities", () => {
  const start = event("turn.started", "start", 0);
  const session = { sessionId: "session", events: [start] };
  for (const [sessions, message] of [
    [[{}], /Unsupported session capture/],
    [[{ ...session, events: [{ type: "turn.started" }] }], /Unsupported event capture/],
    [
      [session, { ...session, events: [{ ...start, data: { changed: true } }] }],
      /Conflicting event identity/,
    ],
    [[session, { ...session, sessionId: "other" }], /Ambiguous session evidence/],
  ])
    assert.throws(() => captureSessions(sessions), message);
});
