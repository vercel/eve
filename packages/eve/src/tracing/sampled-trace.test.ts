import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTracePolicy, resolveTracePolicyDecision } from "#tracing/sampled-trace.js";

describe("resolveTracePolicyDecision", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { action: "drop" },
    { action: "record", recordInputs: false, recordOutputs: false },
    { action: "record", recordInputs: true, recordOutputs: false },
    { action: "record", recordInputs: false, recordOutputs: true },
    { action: "record", recordInputs: true, recordOutputs: true },
  ] as const)("preserves the explicit $action decision", (decision) => {
    expect(resolveTracePolicyDecision(decision, "private")).toEqual(decision);
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
});
