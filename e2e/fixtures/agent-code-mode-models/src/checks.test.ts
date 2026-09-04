import assert from "node:assert/strict";
import { test } from "node:test";
import type { Call } from "./audit.ts";
import { concurrentBalances, inOneProgram, parseAnswer, readEveryPage } from "./checks.ts";

function call(index: number, overrides: Partial<Call> = {}): Call {
  return {
    callId: `program:tool-${index}`,
    tool: "orders",
    input: {},
    started: 0,
    finished: 10,
    status: "completed",
    ...overrides,
  };
}

test("a fabricated answer without recorded tool execution cannot pass", () => {
  assert.equal(inOneProgram([], ["program"]), false);
  assert.equal(readEveryPage([], [null, "next"]), false);
  assert.equal(concurrentBalances([], ["north", "south", "archive"], "archive"), false);
});

test("data calls must share a completed program, allowing separate discovery programs", () => {
  const calls = [call(1), call(2)];
  assert.equal(inOneProgram(calls, ["discovery", "program"]), true);
  assert.equal(inOneProgram(calls, ["discovery"]), false);
  assert.equal(
    inOneProgram([call(1), call(2, { callId: "other:tool-2" })], ["program", "other"]),
    false,
  );
  assert.equal(inOneProgram([call(1, { callId: "program-other:tool-1" })], ["program"]), false);
});

test("pagination rejects omitted, repeated, invalid, or failed pages", () => {
  const first = call(1);
  const second = call(2, { input: { cursor: "next" } });
  assert.equal(readEveryPage([first, second], [null, "next"]), true);
  assert.equal(readEveryPage([first], [null, "next"]), false);
  assert.equal(readEveryPage([first, first], [null, "next"]), false);
  assert.equal(
    readEveryPage([first, call(2, { input: { cursor: "wrong" } })], [null, "next"]),
    false,
  );
  assert.equal(readEveryPage([first, { ...second, status: "failed" }], [null, "next"]), false);
});

test("fanout requires actual overlap and the expected per-source outcomes", () => {
  const ids = ["north", "south", "archive"];
  const calls = ids.map((id, index) =>
    call(index, {
      tool: "balances",
      input: { accountId: id },
      started: index,
      finished: 10,
      status: id === "archive" ? "failed" : "completed",
    }),
  );
  assert.equal(concurrentBalances(calls, ids, "archive"), true);
  assert.equal(
    concurrentBalances(
      calls.map((entry, index) => ({ ...entry, started: index * 20, finished: index * 20 + 10 })),
      ids,
      "archive",
    ),
    false,
  );
  assert.equal(
    concurrentBalances(
      calls.map((entry) => ({ ...entry, status: "completed" })),
      ids,
      "archive",
    ),
    false,
  );
  assert.equal(concurrentBalances(calls.slice(0, 2), ids, "archive"), false);
});

test("JSON answers accept a code fence without requiring exact prose", () => {
  assert.deepEqual(parseAnswer('```json\n{"totalAvailableCents":123}\n```'), {
    totalAvailableCents: 123,
  });
  assert.equal(parseAnswer("I checked everything"), undefined);
});
