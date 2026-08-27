import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTracePolicy, resolveTracePolicyDecision } from "#tracing/sampled-trace.js";

describe("resolveTracePolicyDecision", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [{ emit: false }, { action: "drop" }],
    [
      { emit: true, recordInputs: false, recordOutputs: false },
      { action: "record", recordInputs: false, recordOutputs: false },
    ],
    [
      { emit: true, recordInputs: true, recordOutputs: false },
      { action: "record", recordInputs: true, recordOutputs: false },
    ],
    [
      { emit: true, recordInputs: false, recordOutputs: true },
      { action: "record", recordInputs: false, recordOutputs: true },
    ],
    [
      { emit: true, recordInputs: true, recordOutputs: true },
      { action: "record", recordInputs: true, recordOutputs: true },
    ],
  ] as const)("normalizes the explicit $decision.emit decision", (decision, expected) => {
    expect(resolveTracePolicyDecision(decision, "private")).toEqual(expected);
  });

  it("maps false to the legacy drop behavior", () => {
    expect(resolveTracePolicyDecision(false, "public")).toEqual({ action: "drop" });
  });

  it.each([
    ["public", true],
    ["private", false],
    ["unknown", false],
  ] as const)("maps true through the hosted %s audience ceiling", (audience, content) => {
    expect(resolveTracePolicyDecision(true, audience)).toEqual({
      action: "record",
      recordInputs: content,
      recordOutputs: content,
    });
  });

  it("preserves unknown local content for a legacy true decision", () => {
    vi.stubEnv("EVE_DEV", "1");
    expect(resolveTracePolicyDecision(true, "unknown")).toEqual({
      action: "record",
      recordInputs: true,
      recordOutputs: true,
    });
  });

  it("fails closed when the policy throws", () => {
    expect(
      resolveTracePolicy(
        () => {
          throw new Error("boom");
        },
        { audience: "public" },
      ),
    ).toEqual({ action: "drop" });
  });

  it.each([
    ["public", true],
    ["private", false],
    ["unknown", false],
  ] as const)("emits the default %s trace with the expected content", (audience, content) => {
    expect(resolveTracePolicy(undefined, { audience })).toEqual({
      action: "record",
      recordInputs: content,
      recordOutputs: content,
    });
  });
});
