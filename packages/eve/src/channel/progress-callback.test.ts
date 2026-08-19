import { describe, expect, it } from "vitest";

import { parseProgressCallback } from "#channel/progress-callback.js";

describe("parseProgressCallback", () => {
  it("accepts an absolute public callback whose path carries its token", () => {
    expect(
      parseProgressCallback({
        token: "root-token",
        url: "https://agent.example.com/eve/v1/callback/root-token",
        version: 1,
      }),
    ).toEqual({
      token: "root-token",
      url: "https://agent.example.com/eve/v1/callback/root-token",
      version: 1,
    });
  });

  it("rejects mismatched tokens and reserved callback hosts", () => {
    expect(() =>
      parseProgressCallback({
        token: "other-token",
        url: "https://agent.example.com/eve/v1/callback/root-token",
        version: 1,
      }),
    ).toThrow("token must match");
    expect(() =>
      parseProgressCallback({
        token: "root-token",
        url: "http://169.254.169.254/eve/v1/callback/root-token",
        version: 1,
      }),
    ).toThrow("private or reserved");
  });
});
