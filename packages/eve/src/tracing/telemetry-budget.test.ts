import { describe, expect, it } from "vitest";
import { telemetryByteLength, truncateTelemetryText } from "#tracing/telemetry-budget.js";

describe("trace text bounds", () => {
  it("counts UTF-8 bytes without splitting characters", () => {
    const text = String.fromCodePoint(0x1f600).repeat(1000);
    const truncated = truncateTelemetryText(text, 100);
    expect(telemetryByteLength(truncated)).toBeLessThanOrEqual(100);
    expect(truncated).not.toContain("\ufffd");
  });
});
