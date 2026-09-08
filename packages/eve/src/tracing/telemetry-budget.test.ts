import { describe, expect, it } from "vitest";
import {
  boundedTelemetryJson,
  telemetryByteLength,
  truncateTelemetryText,
} from "#tracing/telemetry-budget.js";
import { runtimeContextAttributes } from "#tracing/agent-otel-runtime-context.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";

describe("telemetry budgets", () => {
  it("keeps oversized tool payloads parseable and explicitly truncated", () => {
    const text = contentAttribute({ text: "x".repeat(40_000) }, false)!;
    expect(JSON.parse(text)).toMatchObject({ "eve.truncated": true });
    expect(telemetryByteLength(text)).toBeLessThanOrEqual(32 * 1024);
  });

  it("counts UTF-8 bytes without splitting characters", () => {
    const text = String.fromCodePoint(0x1f600).repeat(1000);
    const truncated = truncateTelemetryText(text, 100);
    expect(telemetryByteLength(truncated)).toBeLessThanOrEqual(100);
    expect(truncated).not.toContain("\ufffd");
    expect(JSON.parse(boundedTelemetryJson({ text }, 128)!)).toHaveProperty("eve.truncated", true);
  });

  it("bounds cyclic and wide payload traversal", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(JSON.parse(boundedTelemetryJson(circular)!)).toHaveProperty("eve.truncated", true);
    expect(
      telemetryByteLength(boundedTelemetryJson(Array.from({ length: 50_000 }, () => "data"))!),
    ).toBeLessThanOrEqual(32 * 1024);
  });

  it("bounds context cardinality and preserves a truncation signal", () => {
    const context = Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`key${i}`, "x".repeat(1000)]),
    );
    const attrs = runtimeContextAttributes(context);
    expect(Object.keys(attrs).length).toBeLessThanOrEqual(64);
    expect(attrs["ai.settings.context.eve.telemetry.truncated"]).toBe(true);
    expect(telemetryByteLength(JSON.stringify(attrs))).toBeLessThan(70 * 1024);
  });
});
