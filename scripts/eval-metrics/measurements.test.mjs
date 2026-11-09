import test from "node:test";
import assert from "node:assert/strict";
import { captureSessions } from "./measurements/events.mjs";

const fact = (type, line, data = {}, meta = {}) => ({
  type,
  data,
  meta: { at: `2026-01-01T00:00:0${line}Z`, position: { line, index: 0 }, ...meta },
});

test("deduplicates repeated captures by stream position without losing later events", () => {
  const start = fact("turn.started", 0, { turnId: "turn" });
  const later = fact("turn.settled", 1, { turnId: "turn", outcome: "completed" });
  // Readers attach `meta` per read: the same fact can come back with another `endOfLine`.
  const reread = { ...structuredClone(start), meta: { ...start.meta, endOfLine: true } };
  const capture = captureSessions([
    { sessionId: "session", events: [start, structuredClone(start)] },
    { sessionId: "session", events: [reread, later] },
    // The same position in another session is another event.
    { sessionId: "child", events: [structuredClone(start)] },
  ]);
  assert.deepEqual(capture.bySession.get("session"), [start, later]);
  assert.equal(capture.bySession.get("child").length, 1);
});

test("rejects malformed or conflicting capture identities", () => {
  const start = fact("turn.started", 0, { turnId: "turn" });
  const session = { sessionId: "session", events: [start] };
  for (const [sessions, message] of [
    [[{}], /Unsupported session capture/],
    [[{ ...session, events: [{ type: "turn.started", meta: {} }] }], /Unsupported event capture/],
    [
      [session, { ...session, events: [{ ...start, data: { turnId: "other" } }] }],
      /Conflicting event identity/,
    ],
  ])
    assert.throws(() => captureSessions(sessions), message);
});

test("a pre-v27 capture is identified by event id and upgraded to v27 facts", () => {
  const legacy = (type, id, data) => ({
    type,
    data,
    meta: { id, at: "2026-01-01T00:00:00Z", deliveryIds: ["d"] },
  });
  const start = legacy("turn.started", "evt_1", { turnId: "turn" });
  const capture = captureSessions([
    { sessionId: "session", events: [start, structuredClone(start)] },
  ]);
  assert.deepEqual(
    capture.bySession.get("session").map((e) => [e.type, e.data]),
    [
      ["turn.started", { turnId: "turn", trace: undefined, cause: { deliveryId: "d" } }],
      ["delivery.consumed", { deliveryId: "d", turnId: "turn", parts: [] }],
    ],
  );
  // Old event ids are global: one event in two sessions is captured in the wrong one.
  assert.throws(
    () =>
      captureSessions([
        { sessionId: "session", events: [start] },
        { sessionId: "other", events: [structuredClone(start)] },
      ]),
    /Ambiguous session evidence/,
  );
});
