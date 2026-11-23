import assert from "node:assert/strict";
import { test } from "node:test";

import { enforceRateLimit, RateLimitError } from "./rate-limit.ts";

test("without Redis, each instance still stops a caller past the limit", async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.KV_REST_API_URL;
  const options = { key: "1.2.3.4", limit: 3, prefix: "test", windowSeconds: 60 };
  for (let attempt = 0; attempt < 3; attempt++) await enforceRateLimit(options);
  await assert.rejects(enforceRateLimit(options), RateLimitError);
  await enforceRateLimit({ ...options, key: "5.6.7.8" });
});

test("a release takes the count back from its own window, even after the next one began", async (t) => {
  const { countInWindow } = await import("./rate-limit.ts");
  const options = { key: "9.9.9.9", prefix: "test-release", windowSeconds: 60 };
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const first = await countInWindow(options);
  assert.equal(first.count, 1);
  t.mock.timers.setTime(61_000);
  const next = await countInWindow(options);
  assert.equal(next.count, 1);
  await first.release();
  assert.equal((await countInWindow(options)).count, 2);
});
