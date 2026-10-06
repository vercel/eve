import test from "node:test";
import assert from "node:assert/strict";
import { captureSessions, selectEvents } from "./measurements/events.mjs";
import { completedTurns, delegatedSessions, parentTurnStarts } from "./measurements/lifecycle.mjs";
import { elapsedTime, totalToolCalls, totalTurnDuration } from "./measurements/metrics.mjs";

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
  assert.equal(capture.sessionId(start), "session");
  assert.deepEqual(capture.refs([start]), [{ sessionId: "session", eventId: "start" }]);
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

test("measures spans, active turn time, and session-scoped tool calls independently", () => {
  const capture = captureSessions([
    {
      sessionId: "alice",
      events: [
        ...turn("one", 1, 3),
        ...turn("two", 6, 9),
        event("actions.requested", "actions-one", 2, {
          turnId: "one",
          actions: [
            { kind: "tool-call", callId: "call" },
            { kind: "tool-call", callId: "call" },
            { kind: "text" },
          ],
        }),
        event("actions.requested", "actions-two", 7, {
          turnId: "two",
          actions: [{ kind: "tool-call", callId: "call" }],
        }),
        event("actions.requested", "unrelated", 8, {
          turnId: "unselected",
          actions: [{ kind: "tool-call" }],
        }),
      ],
    },
    {
      sessionId: "bob",
      events: [
        ...turn("three", 2, 4),
        event("actions.requested", "actions-three", 3, {
          turnId: "three",
          actions: [{ kind: "tool-call", callId: "call" }],
        }),
      ],
    },
  ]);
  const { turns } = completedTurns(capture, ["alice", "bob"]);
  const span = elapsedTime(
    capture,
    turns.map((t) => t.start),
    turns.map((t) => t.completed),
  );
  assert.equal(span.value, 8000);
  assert.equal(totalTurnDuration(capture, turns).value, 7000);
  const calls = totalToolCalls(capture, turns);
  assert.equal(calls.value, 2);
  assert.equal(calls.evidence.length, 9);
  assert(!calls.evidence.some((ref) => ref.eventId === "unrelated"));
});

test("turn matching rejects incomplete and ambiguous evidence", () => {
  const [start, end] = turn("one", 1, 3);
  for (const [events, reason] of [
    [[], "missing-turn"],
    [[{ ...start, data: {} }, end], "missing-turn-identity"],
    [[start], "turn-incomplete"],
    [[start, end, { ...start, meta: { ...start.meta, id: "another-start" } }], "ambiguous-turn"],
    [[start, end, { ...end, meta: { ...end.meta, id: "another-end" } }], "ambiguous-turn"],
    [[start, end, event("turn.completed", "orphan", 4, { turnId: "other" })], "turn-start-missing"],
  ]) {
    const capture = captureSessions([{ sessionId: "session", events }]);
    assert.deepEqual(completedTurns(capture, ["session"]), { status: "unavailable", reason });
  }
});

test("duration failures do not prevent independent tool counting", () => {
  for (const [start, end, reason] of [
    [3, 1, "negative-duration"],
    ["invalid", 3, "missing-timestamp"],
    [1, "invalid", "missing-timestamp"],
  ]) {
    const capture = captureSessions([{ sessionId: "session", events: turn("one", start, end) }]);
    const { turns } = completedTurns(capture, ["session"]);
    assert.deepEqual(totalTurnDuration(capture, turns), { status: "unavailable", reason });
    assert.deepEqual(elapsedTime(capture, [turns[0].start], [turns[0].completed]), {
      status: "unavailable",
      reason,
    });
    assert.equal(totalToolCalls(capture, turns).value, 0);
  }
});

test("delegation helpers work with any subagent and allow repeated calls to the same child", () => {
  const calls = ["first", "later"].map((callId) =>
    event("subagent.called", callId, 1, {
      name: "editor",
      childSessionId: "child",
      turnId: "parent-turn",
      callId,
    }),
  );
  const sessions = [
    {
      sessionId: "parent",
      events: [event("turn.started", "parent-start", 0, { turnId: "parent-turn" }), ...calls],
    },
    {
      sessionId: "child",
      events: [
        event("session.started", "child-session", 1, {
          invocation: {
            kind: "subagent",
            name: "editor",
            parentCallId: "first",
            parentSessionId: "parent",
            parentTurnId: "parent-turn",
          },
        }),
        ...turn("child-turn", 2, 3),
      ],
    },
  ];
  const capture = captureSessions(sessions);
  assert.deepEqual(delegatedSessions(capture, calls), { status: "ready", sessionIds: ["child"] });
  assert.equal(parentTurnStarts(capture, calls).events.length, 2);
  sessions[1].events[0].data.invocation.parentCallId = "later";
  assert.equal(
    delegatedSessions(captureSessions(sessions), calls).reason,
    "child-invocation-mismatch",
  );
  sessions[1].events[0].data = { runtime: { agentId: "editor" } };
  assert.deepEqual(delegatedSessions(captureSessions(sessions), calls), {
    status: "ready",
    sessionIds: ["child"],
  });
  sessions[1].events[0].data.runtime.agentId = "wrong-agent";
  assert.equal(
    delegatedSessions(captureSessions(sessions), calls).reason,
    "child-invocation-mismatch",
  );
  sessions[1].events[0].data.runtime.agentId = "editor";
  sessions[0].events.push(
    event("subagent.called", "unrelated", 1, {
      name: "other-agent",
      childSessionId: "child",
      turnId: "parent-turn",
      callId: "other-call",
    }),
  );
  assert.equal(
    delegatedSessions(captureSessions(sessions), sessions[0].events.slice(1)).reason,
    "ambiguous-child-parent",
  );
});
