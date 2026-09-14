import { describe, expect, it } from "vitest";

import { parseActivitySink } from "#channel/activity-sink.js";

const token = "abcdefghijklmnopqrstuvwxyz123456";

describe("parseActivitySink", () => {
  it("accepts an absolute public activity capability URL", () => {
    const sink = {
      url: `https://agent.example.com/eve/v1/activity/${token}`,
      version: 1 as const,
    };
    expect(parseActivitySink(sink)).toEqual(sink);
  });

  it("rejects missing opaque tokens and reserved sink hosts", () => {
    expect(() =>
      parseActivitySink({ url: "https://agent.example.com/eve/v1/activity/short", version: 1 }),
    ).toThrow("opaque activity token");
    expect(() =>
      parseActivitySink({ url: `http://169.254.169.254/eve/v1/activity/${token}`, version: 1 }),
    ).toThrow("private or reserved");
  });
});
