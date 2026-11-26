import { expect, it } from "vitest";

import { rateLimitWorkflow } from "#internal/testing/rate-limit-workflow.js";
import { start } from "#internal/workflow/runtime.js";

it("rateLimit from eve/experimental/workflow acquires a slot and rejects past maxWait with RateLimitMaxWaitError", async () => {
  const key = `eve-test-rate-limit-${crypto.randomUUID()}`;
  const run = await start(rateLimitWorkflow, [key]);
  const result = await run.returnValue;

  expect(result).toEqual({
    acquiredFirst: true,
    secondMaxWaitRejected: true,
    errorKey: key,
    wouldAcquireAt: expect.any(Date),
  });
}, 60_000);
