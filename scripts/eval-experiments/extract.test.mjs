import test from "node:test";
import assert from "node:assert/strict";
import { extractSample } from "./extract.mjs";

const event = (type, id, at, data, sessionId) => ({ type, data, meta: { id, at, sessionId } });
function input({ child = [], parent = [], sessions = true, verdict = "passed" } = {}) {
  return {
    identity: {
      variant: "baseline",
      fixture: "agent-self-modification",
      eval: "self-modification/create-shipping-quote",
      model: "openai-sol",
      repetition: 0,
    },
    verdict,
    artifact: {
      result: {
        sessions: sessions
          ? [
              {
                sessionId: "parent",
                events: [
                  event(
                    "turn.started",
                    "ps",
                    "2026-01-01T00:00:00.000Z",
                    { turnId: "pt" },
                    "parent",
                  ),
                  event(
                    "subagent.called",
                    "call-event",
                    "2026-01-01T00:00:01.000Z",
                    {
                      name: "self-modification__agent",
                      childSessionId: "child",
                      turnId: "pt",
                      callId: "call",
                    },
                    "parent",
                  ),
                  ...parent,
                ],
              },
              {
                sessionId: "child",
                events: [
                  event(
                    "session.started",
                    "ss",
                    "2026-01-01T00:00:01.500Z",
                    {
                      invocation: {
                        kind: "subagent",
                        parentCallId: "call",
                        parentSessionId: "parent",
                        parentTurnId: "pt",
                        name: "self-modification__agent",
                      },
                    },
                    "child",
                  ),
                  event(
                    "turn.started",
                    "cs",
                    "2026-01-01T00:00:02.000Z",
                    { turnId: "ct" },
                    "child",
                  ),
                  ...child,
                ],
              },
            ]
          : undefined,
      },
    },
  };
}
const completed = event(
  "turn.completed",
  "ce",
  "2026-01-01T00:00:05.000Z",
  { turnId: "ct" },
  "child",
);

test("measures correlated child work and deduplicates delivery by event id", () => {
  const duplicate = { ...completed };
  const action = event(
    "actions.requested",
    "tools",
    "2026-01-01T00:00:03.000Z",
    {
      turnId: "ct",
      actions: [
        { kind: "tool-call", callId: "tool-1" },
        { kind: "tool-call", callId: "tool-1" },
        { kind: "tool-call", callId: "tool-2" },
      ],
    },
    "child",
  );
  const sample = extractSample(input({ child: [action, completed, duplicate] }));
  assert.equal(sample.measurement.status, "complete");
  assert.deepEqual(sample.metrics, {
    creationElapsedMs: 5000,
    childTurnMs: 3000,
    childToolCalls: 2,
  });
  assert.equal(sample.events.childCompletion.id, "ce");
});

test("keeps missing capture, boundaries, parked input, and failed turns incomplete", () => {
  assert.equal(
    extractSample(input({ sessions: false })).measurement.reason,
    "missing-session-capture",
  );
  assert.equal(extractSample(input()).measurement.reason, "missing-child-turn-boundary");
  assert.equal(
    extractSample(
      input({
        child: [
          event("input.requested", "approval", "2026-01-01T00:00:03Z", { turnId: "ct" }),
          completed,
        ],
      }),
    ).measurement.reason,
    "child-turn-parked",
  );
  assert.equal(
    extractSample(
      input({
        child: [
          event("turn.failed", "failure", "2026-01-01T00:00:03Z", { turnId: "ct" }),
          completed,
        ],
      }),
    ).measurement.reason,
    "child-turn-failed",
  );
});

test("rejects ambiguous delegation and reused child turn capture", () => {
  const base = input({ child: [completed] });
  const duplicateDelegation = structuredClone(base);
  duplicateDelegation.artifact.result.sessions[0].events.push(
    event(
      "subagent.called",
      "another-call",
      "2026-01-01T00:00:01.100Z",
      { name: "self-modification__agent", childSessionId: "child", turnId: "pt", callId: "call-2" },
      "parent",
    ),
  );
  assert.equal(extractSample(duplicateDelegation).measurement.reason, "ambiguous-delegation");
  const reused = input({
    child: [event("turn.started", "cs2", "2026-01-01T00:00:06Z", { turnId: "ct2" }), completed],
  });
  assert.equal(extractSample(reused).measurement.reason, "ambiguous-child-turn");
});
