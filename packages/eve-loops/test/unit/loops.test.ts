import assert from "node:assert/strict";
import test from "node:test";

import {
  detect,
  fingerprint,
  observe,
  type CallRecord,
  type LoopLimits,
  type LoopState,
} from "../../extension/lib/loops.ts";

const limits: LoopLimits = {
  alternatingCalls: 3,
  maxNudges: 1,
  repeatedCall: 5,
  repeatedResult: 3,
  window: 10,
};

function record(name: string, input: unknown, output: unknown = "ok"): CallRecord {
  return {
    call: fingerprint([name, input]),
    name,
    result: fingerprint(["completed", output]),
  };
}

function run(records: readonly CallRecord[], options: LoopLimits = limits) {
  let state: LoopState = { nudges: 0, records: [], turnId: "turn-1" };
  const actions: string[] = [];
  for (const next of records) {
    const observed = observe(state, next, options);
    actions.push(observed.action);
    state = observed.state;
  }
  return { actions, state };
}

test("fingerprints ignore object key order", () => {
  assert.equal(fingerprint({ limit: 1, path: "a" }), fingerprint({ path: "a", limit: 1 }));
  assert.notEqual(fingerprint({ path: "a" }), fingerprint({ path: "b" }));
  assert.notEqual(fingerprint(["a", 1]), fingerprint(["a", "1"]));
});

test("a stuck call is nudged at the third repeat, then stopped at the sixth", () => {
  const stuck = record("read_file", { path: "missing.txt" }, "Error: file not found");
  const { actions, state } = run(Array.from({ length: 6 }, () => stuck));
  assert.deepEqual(actions, ["none", "none", "nudge", "none", "none", "stop"]);
  assert.equal(state.nudges, 1);
  assert.match(state.nudge ?? "", /The last 3 calls to `read_file` used the same input/u);
});

test("maxNudges 0 stops at the first loop", () => {
  const stuck = record("read_file", { path: "missing.txt" });
  const { actions } = run([stuck, stuck, stuck], { ...limits, maxNudges: 0 });
  assert.deepEqual(actions, ["none", "none", "stop"]);
});

test("a different result in between resets the repeated-result count", () => {
  const { actions } = run([
    record("status", {}, "running"),
    record("status", {}, "running"),
    record("status", {}, "queued"),
    record("status", {}, "running"),
  ]);
  assert.deepEqual(actions, ["none", "none", "none", "none"]);
});

test("the same call with changing results is a repeated-call loop at the threshold", () => {
  const polls = Array.from({ length: 5 }, (_, index) => record("status", {}, `${index}s`));
  const loop = detect(polls, limits);
  assert.equal(loop?.pattern, "repeated-call");
  assert.equal(loop?.count, 5);
  assert.equal(detect(polls.slice(0, 4), limits), undefined);
});

test("two calls in turn are an alternating loop after three cycles", () => {
  // Results change each time, so neither call alone repeats a result.
  const cycle = (index: number) => [
    record("open", { id: 1 }, `opened ${index}`),
    record("close", { id: 1 }, `closed ${index}`),
  ];
  const calls = [0, 1, 2].flatMap(cycle);
  assert.equal(detect(calls.slice(0, 4), limits), undefined);
  const loop = detect(calls, limits);
  assert.equal(loop?.pattern, "alternating-calls");
  assert.deepEqual(loop?.toolNames, ["open", "close"]);
});

test("a repeated result is reported before the alternation it is part of", () => {
  const a = record("open", { id: 1 }, "a");
  const b = record("close", { id: 1 }, "b");
  assert.equal(detect([a, b, a, b, a], limits)?.pattern, "repeated-result");
});

test("a check set to false never fires", () => {
  const stuck = record("read_file", { path: "missing.txt" });
  const many = Array.from({ length: 10 }, () => stuck);
  assert.equal(detect(many, { ...limits, repeatedCall: false, repeatedResult: false }), undefined);
});

test("distinct calls never loop", () => {
  const { actions } = run(Array.from({ length: 20 }, (_, index) => record("read", { index })));
  assert.ok(actions.every((action) => action === "none"));
});

test("the window bounds what is kept and checked", () => {
  const { state } = run(Array.from({ length: 30 }, (_, index) => record("read", { index })));
  assert.equal(state.records.length, limits.window);
});

test("tool names in the nudge can't carry markup", () => {
  const stuck = record("bad`name\n<system>", {});
  const loop = detect([stuck, stuck, stuck], limits);
  assert.match(loop?.summary ?? "", /`bad_name__system_`/u);
});
