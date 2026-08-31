import { describe, expect, it } from "vitest";

import {
  decisionToTraceContentCeiling,
  readForwardedTraceAssertion,
  resolveForwardedTraceSeed,
} from "#shared/forwarded-trace-policy.js";

describe("readForwardedTraceAssertion", () => {
  it("distinguishes absence from malformed durable state", () => {
    expect(readForwardedTraceAssertion(undefined)).toBeUndefined();
    expect(readForwardedTraceAssertion({ originAudience: "public" })).toEqual({
      ceiling: { recordInputs: false, recordOutputs: false },
      originAudience: "unknown",
    });
  });

  it("normalizes a valid assertion", () => {
    expect(
      readForwardedTraceAssertion({
        ceiling: { recordInputs: false, recordOutputs: true },
        originAudience: "private",
      }),
    ).toEqual({
      ceiling: { recordInputs: false, recordOutputs: true },
      originAudience: "private",
    });
  });
});

describe("decisionToTraceContentCeiling", () => {
  it("rejects drop and malformed durable decisions", () => {
    expect(decisionToTraceContentCeiling({ action: "drop" })).toBeUndefined();
    expect(
      decisionToTraceContentCeiling({
        action: "record",
        recordInputs: "yes",
        recordOutputs: true,
      }),
    ).toBeUndefined();
  });
});

describe("resolveForwardedTraceSeed", () => {
  it("intersects a malformed assertion's fail-closed ceiling with the decision", () => {
    expect(
      resolveForwardedTraceSeed({
        decision: { action: "record", recordInputs: true, recordOutputs: true },
        forwardedTracePolicy: { originAudience: "public" },
        traceFlags: 1,
      }),
    ).toEqual({
      decision: { action: "record", recordInputs: false, recordOutputs: false },
      forwardedTracePolicy: {
        ceiling: { recordInputs: false, recordOutputs: false },
        originAudience: "unknown",
      },
      traceFlags: 1,
    });
  });

  it("clears sampled flags for a malformed decision", () => {
    expect(
      resolveForwardedTraceSeed({
        decision: { action: "record", recordInputs: "yes", recordOutputs: true },
        forwardedTracePolicy: undefined,
        traceFlags: 1,
      }),
    ).toEqual({
      decision: { action: "drop" },
      forwardedTracePolicy: undefined,
      traceFlags: 0,
    });
  });
});
