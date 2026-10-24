import assert from "node:assert/strict";
import { test } from "node:test";

import { runPool } from "./pool.mjs";

test("keeps at most `concurrency` workers in flight and refills as each finishes", async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const delays = [30, 5, 5, 5, 5];
  const results = await runPool(delays, 2, async (delay, index) => {
    started.push(index);
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    active--;
    if (index === 3) throw new Error("boom");
    return index;
  });

  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled"],
  );
  assert.equal(results[0].value, 0);
});

test("rejects a non-positive concurrency", async () => {
  await assert.rejects(
    runPool([1], 0, async () => {}),
    /positive integer/u,
  );
});
