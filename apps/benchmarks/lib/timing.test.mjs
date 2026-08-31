import assert from "node:assert/strict";
import { test } from "node:test";

import { BenchmarkTimings } from "./timing.ts";

test("records successful and failed phases", async () => {
  const timings = new BenchmarkTimings();
  await timings.measure("success", async () => undefined, { turns: 1 });
  await assert.rejects(timings.measure("failure", async () => Promise.reject(new Error("nope"))));

  assert.equal(timings.entries.length, 2);
  assert.deepEqual(
    timings.entries.map(({ phase, outcome, details }) => ({ phase, outcome, details })),
    [
      { phase: "success", outcome: "success", details: { turns: 1 } },
      { phase: "failure", outcome: "failure", details: undefined },
    ],
  );
  assert.ok(timings.entries.every((entry) => entry.durationMs >= 0));
});
