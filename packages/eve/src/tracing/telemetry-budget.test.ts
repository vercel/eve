import { describe, expect, it } from "vitest";
import {
  boundedPrincipalId,
  telemetryByteLength,
  truncateTelemetryText,
} from "#tracing/telemetry-budget.js";

describe("boundedPrincipalId", () => {
  it.each(["x".repeat(1024), String.fromCodePoint(0x1f600).repeat(256)])(
    "preserves a principal ID at the UTF-8 byte limit",
    (id) => expect(boundedPrincipalId(id)).toBe(id),
  );

  it.each([undefined, null, 123, "", "x".repeat(1025), String.fromCodePoint(0x1f600).repeat(257)])(
    "omits malformed, empty, or oversized IDs",
    (id) => expect(boundedPrincipalId(id)).toBeUndefined(),
  );
});

describe("trace text bounds", () => {
  it("counts UTF-8 bytes without splitting characters", () => {
    const text = String.fromCodePoint(0x1f600).repeat(1000);
    const truncated = truncateTelemetryText(text, 100);
    expect(telemetryByteLength(truncated)).toBeLessThanOrEqual(100);
    expect(truncated).not.toContain("\ufffd");
  });

  it("keeps surrogate pairs intact at every prefix and byte boundary", () => {
    const text = `ab${String.fromCodePoint(0x1f600)}cd`.repeat(20);
    for (let maxBytes = 0; maxBytes <= telemetryByteLength(text) + 1; maxBytes++) {
      const truncated = truncateTelemetryText(text, maxBytes);
      expect(telemetryByteLength(truncated)).toBeLessThanOrEqual(maxBytes);
      expect(truncated).not.toContain("\ufffd");
    }
  });

  it.each([16, 17, 32, 4096])(
    "does not emit a surrogate split at the %i-byte prefix",
    (maxBytes) => {
      const text = "a".repeat(maxBytes) + String.fromCodePoint(0x1f600) + "tail";
      expect(truncateTelemetryText(text, maxBytes)).toBe(
        "a".repeat(maxBytes - "... [truncated]".length) + "... [truncated]",
      );
    },
  );
});
