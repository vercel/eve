import assert from "node:assert/strict";
import { test } from "node:test";
import { measureRun, newRow, type Event } from "../evals/row.ts";

const referenceOf = (name: string) => `REF-${name}`;
const step = (inputTokens: number): Event => ({
  type: "step.completed",
  data: { usage: { inputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } },
});
const call = (toolName: string): Event => ({
  type: "actions.requested",
  data: { actions: [{ callId: toolName, kind: "tool-call", toolName, input: {} }] },
});
const child: Event = { type: "agent.started", data: { sessionId: "child" } };
const turn = (events: Event[], message = "REF-a", status = "waiting") => ({
  events,
  message,
  status,
});
/** A live turn that settles to `settled`, or rejects after streaming `streamed`. */
const live =
  (settled: ReturnType<typeof turn> | Error, streamed: Event[] = []) =>
  async () => ({
    events: settled instanceof Error ? streamed : settled.events,
    result: async () => {
      if (settled instanceof Error) throw settled;
      return settled;
    },
  });
const clock = () => {
  let t = 0;
  return () => (t += 100);
};

test("a collection failure keeps the parent's costs and what the child streamed", async () => {
  const row = newRow("t", {});
  const failure = new Error("stream broke");
  const { error } = await measureRun({
    row,
    expected: ["a"],
    referenceOf,
    now: clock(),
    start: live(turn([step(1234), call("a"), child])),
    collect: async (_turn, events) => {
      events.push(step(50), call("b"));
      throw failure;
    },
  });
  assert.equal(error, failure);
  assert.equal(row.inputTokens, 1284);
  assert.equal(row.modelCalls, 2);
  assert.equal(row.actions, 2);
  assert.equal(row.success, false);
  assert.equal(row.errorClass, "harness:Error");
  assert.equal(row.harnessError, "stream broke");
  assert.equal(row.latencyMs, 100);
});

test("a timeout while collecting keeps the observed costs", async () => {
  const row = newRow("t", {});
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  await measureRun({
    row,
    expected: ["a"],
    referenceOf,
    start: live(turn([step(1234), call("a"), child])),
    collect: async () => {
      throw timeout;
    },
  });
  assert.equal(row.inputTokens, 1234);
  assert.equal(row.actions, 1);
  assert.equal(row.errorClass, "harness:TimeoutError");
});

test("a turn that times out after a model step and a tool call keeps both", async () => {
  const row = newRow("t", {});
  const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
  const { error, turn: settled } = await measureRun({
    row,
    expected: ["a"],
    referenceOf,
    now: clock(),
    start: live(timeout, [step(1234), call("a")]),
    collect: async () => {
      throw new Error("not reached");
    },
  });
  assert.equal(error, timeout);
  assert.equal(settled, undefined);
  assert.equal(row.inputTokens, 1234);
  assert.equal(row.modelCalls, 1);
  assert.equal(row.actions, 1);
  assert.equal(row.errorClass, "harness:TimeoutError");
  assert.equal(row.latencyMs, 100);
});

test("a turn that fails to start records a failed row with no costs", async () => {
  const row = newRow("t", {});
  const { error } = await measureRun({
    row,
    expected: ["a"],
    referenceOf,
    start: async () => {
      throw new Error("rejected");
    },
    collect: async () => {},
  });
  assert.equal((error as Error).message, "rejected");
  assert.equal(row.inputTokens, 0);
  assert.equal(row.errorClass, "harness:Error");
});

test("a run that calls and quotes every expected tool succeeds", async () => {
  const row = newRow("t", { EVE_ARMS_MODE: "deferred", EVE_ARMS_REPETITION: "2" });
  const { error } = await measureRun({
    row,
    expected: ["a"],
    referenceOf,
    start: live(turn([step(10), call("eve__search"), call("a")])),
    collect: async () => {},
  });
  assert.equal(error, undefined);
  assert.equal(row.success, true);
  assert.equal(row.errorClass, null);
  assert.equal(row.routingCalls, 1);
  assert.equal(row.actions, 1);
  assert.equal(row.arm, "deferred");
  assert.equal(row.repetition, 2);
});

test("failed turns, missing tools and missing references get their own class", async () => {
  const run = async (t: ReturnType<typeof turn>) => {
    const row = newRow("t", {});
    await measureRun({
      row,
      expected: ["a"],
      referenceOf,
      start: live(t),
      collect: async () => {},
    });
    return row.errorClass;
  };
  const failed: Event = { type: "turn.failed", data: { code: "MODEL_CALL_FAILED" } };
  assert.equal(
    await run(turn([call("a"), failed], "REF-a", "failed")),
    "turn-failed:MODEL_CALL_FAILED",
  );
  assert.equal(await run(turn([call("b")])), "tool-not-called");
  assert.equal(await run(turn([call("a")], "no reference")), "reference-missing");
});

test("program attempts, failures and interpreter time come from eve__execute results", async () => {
  const row = newRow("t", {});
  const result = (status: string, output: object, error?: object): Event => ({
    type: "action.result",
    data: { status, error, result: { kind: "tool-result", toolName: "eve__execute", output } },
  });
  await measureRun({
    row,
    expected: ["a"],
    referenceOf,
    start: live(
      turn([
        call("eve__execute"),
        result("failed", { errorClass: "syntax", interpreter: { startupMs: 5, runMs: 1 } }),
        call("eve__execute"),
        call("a"),
        result("completed", { interpreter: { startupMs: 2, runMs: 3 } }),
      ]),
    ),
    collect: async () => {},
  });
  assert.equal(row.programAttempts, 2);
  assert.equal(row.programFailures, 1);
  assert.deepEqual(row.programErrorClasses, ["syntax"]);
  assert.equal(row.interpreterStartupMs, 7);
  assert.equal(row.interpreterRunMs, 4);
  assert.equal(row.actions, 1);
});
