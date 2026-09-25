import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveTracePolicy, resolveTracePolicyDecision } from "#tracing/sampled-trace.js";

const contentContext = (
  audience: "public" | "private" | "unknown",
  environment: "development" | "preview" | "production" = "production",
) => ({ audience, environment });

const traceContext = (
  audience: "public" | "private" | "unknown",
  environment: "development" | "preview" | "production" = "production",
) => ({
  agentName: "weather",
  ...contentContext(audience, environment),
  channel: { kind: "http" as const },
  mode: "conversation" as const,
  principalType: "anonymous",
});

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
    expect(resolveTracePolicyDecision(decision, contentContext("private"))).toEqual(expected);
  });

  it("maps false to the legacy drop behavior", () => {
    expect(resolveTracePolicyDecision(false, contentContext("public"))).toEqual({
      action: "drop",
    });
  });

  it.each([
    ["public", "production", true],
    ["private", "production", false],
    ["unknown", "production", false],
    ["unknown", "development", true],
    ["unknown", "preview", false],
  ] as const)("maps true through the %s %s content ceiling", (audience, environment, content) => {
    expect(resolveTracePolicyDecision(true, contentContext(audience, environment))).toEqual({
      action: "record",
      recordInputs: content,
      recordOutputs: content,
    });
  });

  it("preserves unknown development content for a legacy true decision", () => {
    expect(resolveTracePolicyDecision(true, contentContext("unknown", "development"))).toEqual({
      action: "record",
      recordInputs: true,
      recordOutputs: true,
    });
  });

  it("fails closed when the policy throws", () => {
    expect(
      resolveTracePolicy(() => {
        throw new Error("boom");
      }, traceContext("public")),
    ).toEqual({ action: "drop" });
  });

  it("fails closed when policy error reporting also throws", () => {
    expect(
      resolveTracePolicy(
        () => {
          throw new Error("policy failed");
        },
        traceContext("public"),
        () => {
          throw new Error("reporting failed");
        },
      ),
    ).toEqual({ action: "drop" });
  });

  it.each([
    ["public", "production", true],
    ["private", "production", false],
    ["unknown", "production", false],
    ["unknown", "development", true],
    ["unknown", "preview", false],
  ] as const)(
    "emits the default %s %s trace with the expected content",
    (audience, environment, content) => {
      expect(resolveTracePolicy(undefined, traceContext(audience, environment))).toEqual({
        action: "record",
        recordInputs: content,
        recordOutputs: content,
      });
    },
  );
});
