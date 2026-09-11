import assert from "node:assert/strict";
import { test } from "node:test";

import { checkForTask, eventsForSession, toolEvidence } from "./event-matching.ts";

function event(id, type, data) {
  return { meta: { id, at: "2026-09-11T00:00:00.000Z" }, type, data };
}

function approval(taskId, check, callId = "probe-call") {
  return {
    requestId: `${taskId}:approval-id`,
    kind: "tool-approval",
    action: { kind: "tool-call", toolName: "probe", callId, input: { check } },
  };
}

function requested(id, callId = "probe-call", check = "first") {
  return event(id, "actions.requested", {
    actions: [{ kind: "tool-call", toolName: "probe", callId, input: { check } }],
    turnId: "turn_0",
  });
}

function completed(
  id,
  callId = "probe-call",
  status = "completed",
  output = { result: "oranges" },
) {
  return event(id, "action.result", {
    result: { kind: "tool-result", toolName: "probe", callId, output },
    status,
    turnId: "turn_1",
  });
}

const expected = [
  {
    callId: "probe-call",
    inputs: [{ check: "first" }],
    results: [{ status: "completed", output: { result: "oranges" } }],
  },
];

function snapshots() {
  return [
    {
      sessionId: "parent",
      events: [event("proxy", "input.requested", { requests: [approval("task_a", "first")] })],
    },
    {
      sessionId: "child",
      events: [
        requested("request"),
        event("approval", "input.requested", { requests: [approval("task_a", "first")] }),
      ],
    },
    { sessionId: "child", events: [completed("result")] },
  ];
}

test("joins a paused request to its result in a later approval turn", () => {
  assert.deepEqual(toolEvidence(snapshots(), "child", "probe"), expected);
  assert.deepEqual(toolEvidence(snapshots(), "parent", "probe"), []);
});

test("proxy approvals in both ancestors do not count as nested probe executions", () => {
  const turns = snapshots();
  turns[1].sessionId = "leaf";
  turns[2].sessionId = "leaf";
  turns.push({ sessionId: "child", events: turns[0].events });
  assert.deepEqual(toolEvidence(turns, "leaf", "probe"), expected);
  assert.deepEqual(toolEvidence(turns, "child", "probe"), []);
});

test("only deduplicates event IDs within the owning session, including overlapping watches", () => {
  const turns = snapshots();
  turns.push(...snapshots());
  turns.push({
    sessionId: "sibling",
    events: [
      requested("request", "probe-call", "second"),
      completed("result", "probe-call", "completed", { result: "pears" }),
    ],
  });
  assert.deepEqual(toolEvidence(turns, "child", "probe"), expected);
  assert.equal(eventsForSession(turns, "child").length, 3);
  assert.deepEqual(toolEvidence(turns, "sibling", "probe")[0].inputs, [{ check: "second" }]);
});

test("does not join a same-call-ID request and result from different sessions", () => {
  const turns = snapshots();
  turns[2].sessionId = "sibling";
  assert.deepEqual(toolEvidence(turns, "child", "probe")[0].results, []);
  assert.deepEqual(toolEvidence(turns, "sibling", "probe")[0].inputs, []);
});

for (const [name, extra] of [
  [
    "a second execution with a new call ID",
    [requested("request-2", "second-call"), completed("result-2", "second-call")],
  ],
  ["a duplicate result event for the same call ID", [completed("result-2")]],
  ["a duplicate request event for the same call ID", [requested("request-2")]],
  ["an orphan completion", [completed("orphan", "unknown-call")]],
  ["a pending extra call", [requested("pending", "pending-call")]],
]) {
  test(`exact evidence rejects ${name}`, () => {
    const turns = snapshots();
    turns.push({ sessionId: "child", events: extra });
    assert.notDeepEqual(toolEvidence(turns, "child", "probe"), expected);
  });
}

for (const [name, result] of [
  ["a failed result", completed("result", "probe-call", "failed")],
  ["a rejected result", completed("result", "probe-call", "rejected")],
  ["the wrong output", completed("result", "probe-call", "completed", { result: "pears" })],
  ["the wrong call ID", completed("result", "other-call")],
]) {
  test(`exact evidence rejects ${name}`, () => {
    const turns = snapshots();
    turns[2].events = [result];
    assert.notDeepEqual(toolEvidence(turns, "child", "probe"), expected);
  });
}

test("exact evidence rejects the wrong check or a missing completion", () => {
  const turns = snapshots();
  turns[1].events = [requested("request", "probe-call", "second")];
  assert.notDeepEqual(toolEvidence(turns, "child", "probe"), expected);
  assert.notDeepEqual(toolEvidence(snapshots().slice(0, 2), "child", "probe"), expected);
});

test("maps checks by task-scoped runtime approval, independent of assignment wording or order", () => {
  const requests = [
    approval("task_second", "second"),
    approval("task_third", "third"),
    approval("task_first", "first"),
  ];
  assert.equal(checkForTask("task_first", requests), "first");
  assert.equal(checkForTask("task_second", requests), "second");
  assert.equal(checkForTask("task_third", requests), "third");
  assert.throws(() => checkForTask("task_fir", requests));
});

test("task joins reject missing, ambiguous, invalid, non-approval, and wrong-tool requests", () => {
  const valid = approval("task_a", "first");
  for (const requests of [
    [],
    [approval("task_b", "first")],
    [valid, { ...valid, requestId: "task_a:other-approval" }],
    [approval("task_a", "fourth")],
    [{ ...valid, kind: "question" }],
    [{ ...valid, action: { ...valid.action, toolName: "other-tool" } }],
  ]) {
    assert.throws(() => checkForTask("task_a", requests));
  }
});
