import { describe, expect, expectTypeOf, it } from "vitest";

import { RateLimitMaxWaitError as SdkRateLimitMaxWaitError } from "#compiled/@workflow/errors/index.js";
import * as sdk from "#internal/workflow/index.js";

import * as experimentalWorkflow from "./index.ts";

describe("eve/experimental/workflow", () => {
  it("re-exports the SDK rateLimit and RateLimitMaxWaitError values", () => {
    expect(experimentalWorkflow.rateLimit).toBe(sdk.experimental_rateLimit);
    expect(experimentalWorkflow.RateLimitMaxWaitError).toBe(SdkRateLimitMaxWaitError);

    const wouldAcquireAt = new Date("2026-11-24T00:00:00.000Z");
    const error = new experimentalWorkflow.RateLimitMaxWaitError("openai", wouldAcquireAt);
    expect(error).toBeInstanceOf(SdkRateLimitMaxWaitError);
    expect(experimentalWorkflow.RateLimitMaxWaitError.is(error)).toBe(true);
    expect(error.key).toBe("openai");
    expect(error.wouldAcquireAt).toEqual(wouldAcquireAt);
  });

  it("declares signatures the SDK values satisfy without exposing internal options", () => {
    expectTypeOf(sdk.experimental_rateLimit).toExtend<typeof experimentalWorkflow.rateLimit>();
    expectTypeOf(SdkRateLimitMaxWaitError).toExtend<
      typeof experimentalWorkflow.RateLimitMaxWaitError
    >();

    expectTypeOf(experimentalWorkflow.rateLimit).toBeCallableWith({
      key: "openai",
      limit: 60,
      period: "1m",
      maxWait: "30s",
      burst: 10,
    });
    expectTypeOf(experimentalWorkflow.rateLimit).toBeCallableWith({
      key: "openai",
      limit: 10,
      period: 1_000,
      maxWait: 5_000,
    });

    const checkReservedRejected = () => {
      void experimentalWorkflow.rateLimit({
        key: "openai",
        limit: 1,
        period: "1s",
        // @ts-expect-error Reserved key opt-in is internal to Workflow SDK libraries.
        allowReservedKey: true,
      });
    };
    expect(checkReservedRejected).toBeTypeOf("function");
  });
});
