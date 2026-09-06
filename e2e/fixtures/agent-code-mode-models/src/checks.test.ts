import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { reportSchema } from "./report-schema.ts";
import type { Call } from "./audit.ts";
import { concurrentBalances, inOneProgram, readEveryPage } from "./checks.ts";

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

test("reports whether data calls share a completed program, excluding discovery programs", () => {
  const calls = [call(1), call(2)];
  assert.equal(inOneProgram(calls, ["discovery", "program"]), true);
  assert.equal(inOneProgram(calls, ["discovery"]), false);
  assert.equal(
    inOneProgram([call(1), call(2, { callId: "other:tool-2" })], ["program", "other"]),
    false,
  );
  assert.equal(inOneProgram([call(1, { callId: "program-other:tool-1" })], ["program"]), false);
});

test("pagination requires every valid page, allowing repeated reads and recovered failures", () => {
  const first = call(1);
  const second = call(2, { input: { cursor: "next" } });
  assert.equal(readEveryPage([first, second], [null, "next"]), true);
  assert.equal(readEveryPage([first, first, second], [null, "next"]), true);
  assert.equal(
    readEveryPage([first, { ...second, status: "failed" }, second], [null, "next"]),
    true,
  );
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

test("separate report programs are visible in the efficiency diagnostic", () => {
  const reads = [call(1), call(2)];
  assert.equal(inOneProgram([...reads, call(3, { tool: "save_report" })], ["program"]), true);
  assert.equal(
    inOneProgram(
      [
        ...reads,
        call(3, {
          tool: "save_report",
          callId: "save-later:tool-0",
        }),
      ],
      ["program", "save-later"],
    ),
    false,
  );
});

test("report tool advertises an object root and validates both report shapes", () => {
  const schema = reportSchema;
  assert.ok(schema instanceof z.ZodType);
  assert.equal(z.toJSONSchema(schema).type, "object");
  for (const report of [
    { paidUsdCents: 200, paidUsdOrders: 2 },
    { totalAvailableCents: 300, unavailableAccounts: ["archive"] },
  ]) {
    assert.equal(schema.safeParse({ report }).success, true);
  }
  assert.equal(schema.safeParse({ report: { paidUsdCents: "invalid" } }).success, false);
});
