import { describe, expect, it } from "vitest";

import { parseProgressCallback } from "#channel/progress-callback.js";

const token = "abcdefghijklmnopqrstuvwxyz123456";

describe("parseProgressCallback", () => {
  it("accepts an absolute public progress capability URL", () => {
    const callback = {
      url: `https://agent.example.com/eve/v1/progress/${token}`,
      version: 1 as const,
    };
    expect(parseProgressCallback(callback)).toEqual(callback);
  });

  it("rejects missing opaque tokens and reserved callback hosts", () => {
    expect(() =>
      parseProgressCallback({ url: "https://agent.example.com/eve/v1/progress/short", version: 1 }),
    ).toThrow("opaque progress token");
    expect(() =>
      parseProgressCallback({ url: `http://169.254.169.254/eve/v1/progress/${token}`, version: 1 }),
    ).toThrow("private or reserved");
  });
});
