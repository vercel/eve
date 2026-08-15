import { describe, expect, it } from "vitest";

import { resolveLocalTraceRetentionSettings } from "#tracing/local-trace-retention.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const FIVE_HUNDRED_TWELVE_MIB = 512 * 1024 * 1024;

describe("resolveLocalTraceRetentionSettings", () => {
  it("bounds the store by age, size, and a keep-newest floor by default", () => {
    expect(resolveLocalTraceRetentionSettings({})).toEqual({
      enabled: true,
      maxAgeMs: SEVEN_DAYS_MS,
      maxTotalBytes: FIVE_HUNDRED_TWELVE_MIB,
      retainCount: 20,
    });
  });

  it("reads each bound from the environment", () => {
    expect(
      resolveLocalTraceRetentionSettings({
        EVE_TRACES_MAX_AGE_MS: "1000",
        EVE_TRACES_MAX_TOTAL_BYTES: "2048",
        EVE_TRACES_RETAIN_COUNT: "3",
      }),
    ).toEqual({ enabled: true, maxAgeMs: 1000, maxTotalBytes: 2048, retainCount: 3 });
  });

  it("disables one bound at a time with `off`", () => {
    const settings = resolveLocalTraceRetentionSettings({
      EVE_TRACES_MAX_AGE_MS: "off",
      EVE_TRACES_MAX_TOTAL_BYTES: "OFF",
      EVE_TRACES_RETAIN_COUNT: "false",
    });

    expect(settings).toEqual({
      enabled: true,
      maxAgeMs: false,
      maxTotalBytes: false,
      retainCount: false,
    });
  });

  it("treats EVE_TRACES=off as disabling the whole subsystem", () => {
    for (const value of ["off", "OFF", " false ", "0"]) {
      expect(resolveLocalTraceRetentionSettings({ EVE_TRACES: value }).enabled).toBe(false);
    }
  });

  it("keeps tracing enabled for any other EVE_TRACES value", () => {
    expect(resolveLocalTraceRetentionSettings({ EVE_TRACES: "on" }).enabled).toBe(true);
  });

  it("falls back to the default rather than throwing on an unparseable value", () => {
    const settings = resolveLocalTraceRetentionSettings({
      EVE_TRACES_MAX_AGE_MS: "sometimes",
      EVE_TRACES_RETAIN_COUNT: "-4",
    });

    expect(settings.maxAgeMs).toBe(SEVEN_DAYS_MS);
    expect(settings.retainCount).toBe(20);
  });
});
