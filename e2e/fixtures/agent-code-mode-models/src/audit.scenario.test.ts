import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ToolContext } from "eve/tools";
import { clearCalls, readCalls, record, waitForBalances } from "./audit.ts";
import { concurrentBalances, inOneProgram } from "./checks.ts";

test("the independent audit records concurrent successes and a rejected source", async () => {
  const sessionId = randomUUID();
  const ids = ["north", "south", "archive"];
  try {
    const results = await Promise.allSettled(
      ids.map((id, index) => {
        const ctx = {
          session: { id: sessionId },
          callId: `program:tool-${index}`,
          toolName: "balances",
          abortSignal: AbortSignal.timeout(5_000),
        } as ToolContext;
        return record(ctx, { accountId: id }, async () => {
          await waitForBalances(ctx, ids);
          if (id === "archive") throw new Error("Balance unavailable");
          return 123;
        });
      }),
    );
    assert.deepEqual(
      results.map(({ status }) => status),
      ["fulfilled", "fulfilled", "rejected"],
    );
    const calls = await readCalls(sessionId);
    assert.equal(concurrentBalances(calls, ids, "archive"), true);
    assert.equal(inOneProgram(calls, ["program"]), true);
    assert.deepEqual(await readCalls(randomUUID()), []);
  } finally {
    await clearCalls(sessionId);
  }
  assert.deepEqual(await readCalls(sessionId), []);
});

test("missing peers cannot pass the barrier and cancellation is recorded", async () => {
  const sessionId = randomUUID();
  const ctx = {
    session: { id: sessionId },
    callId: "program:tool-0",
    toolName: "balances",
    abortSignal: AbortSignal.timeout(50),
  } as ToolContext;
  try {
    await assert.rejects(
      record(ctx, { accountId: "north" }, async () => {
        await waitForBalances(ctx, ["north", "south", "archive"]);
      }),
      { name: "AbortError" },
    );
    const calls = await readCalls(sessionId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.status, "failed");
    assert.equal(concurrentBalances(calls, ["north", "south", "archive"], "archive"), false);
  } finally {
    await clearCalls(sessionId);
  }
});
