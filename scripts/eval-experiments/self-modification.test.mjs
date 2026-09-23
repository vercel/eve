import test from "node:test";
import assert from "node:assert/strict";
import { selfModificationMetrics } from "../../experiments/self-modification-metrics.mjs";
const derive = (sessions) => selfModificationMetrics.derive({ result: { sessions } });

const event = (type, id, at, data, sessionId) => ({ type, data, meta: { id, at, sessionId } });
function childSession(sessionId, parentSessionId, parentTurnId, callId, events = []) {
  return {
    sessionId,
    events: [
      event(
        "session.started",
        `${sessionId}-session`,
        "2026-01-01T00:00:01Z",
        {
          invocation: {
            kind: "subagent",
            parentCallId: callId,
            parentSessionId,
            parentTurnId,
          },
        },
        sessionId,
      ),
      ...events,
    ],
  };
}
function captures() {
  const parentId = "parent";
  const childId = "child";
  return [
    {
      sessionId: parentId,
      events: [
        event(
          "turn.started",
          "parent-start",
          "2026-01-01T00:00:00Z",
          { turnId: "parent-turn" },
          parentId,
        ),
        event(
          "subagent.called",
          "delegation",
          "2026-01-01T00:00:01Z",
          {
            name: "self-modification__agent",
            childSessionId: childId,
            turnId: "parent-turn",
            callId: "call",
          },
          parentId,
        ),
      ],
    },
    childSession(childId, parentId, "parent-turn", "call", [
      event(
        "turn.started",
        "child-start",
        "2026-01-01T00:00:02Z",
        { turnId: "child-turn" },
        childId,
      ),
      event(
        "turn.completed",
        "child-completed",
        "2026-01-01T00:00:05Z",
        { turnId: "child-turn" },
        childId,
      ),
    ]),
  ];
}
const evalId = "self-modification/create-shipping-quote";

test("derives independently evidenced durations and a zero-valid tool count", () => {
  const result = selfModificationMetrics.derive({
    id: evalId,
    result: { sessions: captures() },
  });
  assert.equal(result.parentTurnToFinalChildCompletion.value, 5000);
  assert.equal(result.totalChildDuration.value, 3000);
  assert.equal(result.toolCalls.value, 0);
  assert.deepEqual(result.parentTurnToFinalChildCompletion.evidence, [
    { sessionId: "parent", eventId: "parent-start" },
    { sessionId: "parent", eventId: "delegation" },
    { sessionId: "child", eventId: "child-completed" },
  ]);
  assert.deepEqual(result.totalChildDuration.evidence, [
    { sessionId: "child", eventId: "child-start" },
    { sessionId: "child", eventId: "child-completed" },
  ]);
  assert.deepEqual(result.toolCalls.evidence, result.totalChildDuration.evidence);
});

test("measures total child turns for every self-modification eval", () => {
  const evals = [
    "add-agent-browser",
    "add-slack-channel",
    "create-background-replication-check",
    "create-incident-triage",
    "create-shipping-quote",
    "offer-repair",
    "repair-order-total",
  ];
  for (const name of evals) {
    const result = selfModificationMetrics.derive({
      id: `self-modification/${name}`,
      result: { sessions: captures() },
    });
    assert.equal(result.parentTurnToFinalChildCompletion.status, "measured", name);
    assert.equal(result.totalChildDuration.status, "measured", name);
    assert.equal(result.toolCalls.status, "measured", name);
  }
});

test("sums child turn durations across approval pauses and later delegations", () => {
  const sessions = captures();
  const parent = sessions[0];
  const firstChild = sessions[1];
  firstChild.events[2].data.status = "waiting";
  firstChild.events.push(
    event(
      "turn.started",
      "resumed-child-start",
      "2026-01-01T00:00:06Z",
      { turnId: "resumed-child-turn" },
      "child",
    ),
    event(
      "turn.completed",
      "resumed-child-completed",
      "2026-01-01T00:00:08Z",
      { turnId: "resumed-child-turn" },
      "child",
    ),
  );
  parent.events.push(
    event(
      "turn.started",
      "later-parent-start",
      "2026-01-01T00:00:09Z",
      { turnId: "later-parent-turn" },
      "parent",
    ),
    event(
      "subagent.called",
      "later-delegation",
      "2026-01-01T00:00:10Z",
      {
        name: "self-modification__agent",
        childSessionId: "later-child",
        turnId: "later-parent-turn",
        callId: "later-call",
      },
      "parent",
    ),
  );
  const laterChild = childSession("later-child", "parent", "later-parent-turn", "later-call", [
    event(
      "turn.started",
      "later-child-start",
      "2026-01-01T00:00:11Z",
      { turnId: "later-child-turn" },
      "later-child",
    ),
    event(
      "actions.requested",
      "later-child-actions",
      "2026-01-01T00:00:12Z",
      { turnId: "later-child-turn", actions: [{ kind: "tool-call", callId: "tool-call" }] },
      "later-child",
    ),
    event(
      "turn.completed",
      "later-child-completed",
      "2026-01-01T00:00:14Z",
      { turnId: "later-child-turn" },
      "later-child",
    ),
  ]);
  const result = derive([...sessions, laterChild]);
  assert.equal(result.parentTurnToFinalChildCompletion.value, 14_000);
  assert.equal(result.totalChildDuration.value, 8_000);
  assert.equal(result.toolCalls.value, 1);
});

test("returns unavailable when supported eval evidence is missing", () => {
  assert.equal(
    selfModificationMetrics.derive({ id: evalId, result: { sessions: undefined } })
      .parentTurnToFinalChildCompletion.status,
    "unavailable",
  );
  const sessions = captures();
  sessions[0].events = sessions[0].events.filter((item) => item.type !== "turn.started");
  const result = selfModificationMetrics.derive({
    id: evalId,
    result: { sessions },
  });
  assert.equal(result.parentTurnToFinalChildCompletion.status, "unavailable");
  assert.equal(result.totalChildDuration.status, "measured");
  assert.equal(result.toolCalls.status, "measured");
});

test("rejects conflicting event identities and incomplete tool-call identities", () => {
  const sessions = captures();
  sessions[0].events.push(
    event("different.event", "delegation", "2026-01-01T00:00:01Z", {}, "parent"),
  );
  assert.throws(
    () => selfModificationMetrics.derive({ id: evalId, result: { sessions } }),
    /Conflicting event identity/,
  );
  const action = event(
    "actions.requested",
    "actions",
    "2026-01-01T00:00:03Z",
    { turnId: "child-turn", actions: [{ kind: "tool-call" }] },
    "child",
  );
  const sessionsWithMalformedAction = captures();
  sessionsWithMalformedAction[1].events.splice(-1, 0, action);
  const result = derive(sessionsWithMalformedAction);
  assert.equal(result.toolCalls.status, "unavailable");
  assert.equal(result.totalChildDuration.status, "measured");
});

test("keeps experiment missingness policy and reason codes", () => {
  const unavailable = (reason) => ({ status: "unavailable", reason });
  const cases = [
    [
      "missing-delegation",
      (sessions) => {
        sessions[0].events.pop();
      },
    ],
    [
      "missing-delegation-identities",
      (sessions) => {
        delete sessions[0].events[1].data.callId;
      },
    ],
    [
      "child-session-reused",
      (sessions) => {
        sessions[0].events[1].data.childSessionId = "parent";
      },
    ],
    [
      "missing-child-capture",
      (sessions) => {
        sessions.pop();
      },
    ],
    [
      "child-invocation-mismatch",
      (sessions) => {
        sessions[1].events[0].data.invocation.parentCallId = "other";
      },
    ],
    [
      "missing-child-turn",
      (sessions) => {
        sessions[1].events.splice(1);
      },
    ],
    [
      "missing-child-turn-identity",
      (sessions) => {
        delete sessions[1].events[1].data.turnId;
      },
    ],
    [
      "child-turn-incomplete",
      (sessions) => {
        sessions[1].events.pop();
      },
    ],
    [
      "ambiguous-child-turn",
      (sessions) => {
        sessions[1].events.push({
          ...sessions[1].events[2],
          meta: { ...sessions[1].events[2].meta, id: "duplicate-completion" },
        });
      },
    ],
    [
      "child-turn-start-missing",
      (sessions) => {
        sessions[1].events.push(
          event("turn.completed", "orphan", "2026-01-01T00:00:06Z", { turnId: "other" }, "child"),
        );
      },
    ],
  ];
  for (const [reason, mutate] of cases) {
    const sessions = captures();
    mutate(sessions);
    const result = derive(sessions);
    assert.deepEqual(
      Object.keys(result).sort(),
      Object.keys(selfModificationMetrics.metrics).sort(),
    );
    for (const measurement of Object.values(result))
      assert.deepEqual(measurement, unavailable(reason));
  }
});

test("only parent latency depends on unique parent starts", () => {
  const sessions = captures();
  sessions[0].events.push({
    ...sessions[0].events[0],
    meta: { ...sessions[0].events[0].meta, id: "duplicate-start" },
  });
  const result = derive(sessions);
  assert.equal(result.parentTurnToFinalChildCompletion.reason, "ambiguous-parent-turn-start");
  assert.equal(result.totalChildDuration.value, 3000);
  assert.equal(result.toolCalls.value, 0);
});

test("the experiment requires valid child durations before counting tools", () => {
  for (const [at, reason] of [
    ["invalid", "missing-child-timestamp"],
    ["2026-01-01T00:00:06Z", "negative-duration"],
  ]) {
    const sessions = captures();
    sessions[1].events[1].meta.at = at;
    const result = derive(sessions);
    assert.equal(result.parentTurnToFinalChildCompletion.value, 5000);
    assert.deepEqual(result.totalChildDuration, { status: "unavailable", reason });
    assert.deepEqual(result.toolCalls, { status: "unavailable", reason });
  }
});

test("repeated child delegations do not double-count turns or tool calls", () => {
  const sessions = captures();
  sessions[0].events.push(
    event(
      "subagent.called",
      "later-call",
      "2026-01-01T00:00:04Z",
      {
        ...sessions[0].events[1].data,
        callId: "later-call",
      },
      "parent",
    ),
  );
  const result = derive(sessions);
  assert.equal(result.parentTurnToFinalChildCompletion.value, 5000);
  assert.equal(result.totalChildDuration.value, 3000);
  assert.equal(result.toolCalls.value, 0);
});
