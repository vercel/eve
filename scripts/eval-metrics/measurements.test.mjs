import test from "node:test";
import assert from "node:assert/strict";
import { captureSessions, selectEvents } from "./measurements/events.mjs";
import { deriveAttemptMetrics } from "./standard.mjs";

const event = (type, id, second, data = {}) => ({
  type,
  meta: { id, at: `2026-01-01T00:00:${String(second).padStart(2, "0")}Z` },
  data,
});
const turn = (id, start, end) => [
  event("turn.started", `${id}-start`, start, { turnId: id }),
  event("turn.completed", `${id}-end`, end, { turnId: id }),
];

test("indexes captures, deduplicates identical events, and selects exact data fields", () => {
  const start = event("turn.started", "start", 0, { turnId: "turn" });
  const later = event("turn.completed", "completed", 1, { turnId: "turn" });
  const capture = captureSessions([
    { sessionId: "session", events: [start, structuredClone(start)] },
    { sessionId: "session", events: [structuredClone(start), later] },
  ]);
  assert.deepEqual(capture.events, [start, later]);
  assert.deepEqual(capture.bySession.get("session"), [start, later]);
  assert.deepEqual(selectEvents(capture.events, "turn.started", { turnId: "turn" }), [start]);
  assert.deepEqual(selectEvents(capture.events, "turn.started", { turnId: "other" }), []);
  assert.equal(captureSessions(undefined), undefined);
  assert.deepEqual(captureSessions([]).events, []);
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

test("turn pairing makes turn time unavailable on incomplete or ambiguous evidence", () => {
  const [start, end] = turn("one", 1, 3);
  for (const [events, reason] of [
    [[], "missing-turn"],
    [[{ ...start, data: {} }, end], "missing-turn-identity"],
    [[start], "turn-incomplete"],
    [[start, end, { ...start, meta: { ...start.meta, id: "another-start" } }], "ambiguous-turn"],
    [[start, end, { ...end, meta: { ...end.meta, id: "another-end" } }], "ambiguous-turn"],
    [[start, end, event("turn.completed", "orphan", 4, { turnId: "other" })], "turn-start-missing"],
  ]) {
    const artifact = { result: { sessions: [{ sessionId: "session", events }] } };
    assert.deepEqual(deriveAttemptMetrics(artifact).metrics["latency.turn_ms"], {
      status: "unavailable",
      reason,
    });
  }
});
