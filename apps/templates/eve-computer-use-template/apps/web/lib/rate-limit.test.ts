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
