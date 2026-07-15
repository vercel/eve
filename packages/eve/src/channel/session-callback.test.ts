import { describe, expect, it } from "vitest";

import { parseSessionCallback } from "#channel/session-callback.js";

const BASE_CALLBACK = {
  callId: "call-remote",
  subagentName: "research",
  token: "eve:parent-token",
};

describe("parseSessionCallback", () => {
  it("accepts a bare single-agent callback url", () => {
    const result = parseSessionCallback({
      ...BASE_CALLBACK,
      url: "https://caller.example.com/eve/v1/callback/eve%3Aparent-token",
    });

    expect(result.ok).toBe(true);
  });

  it("accepts a callback url carrying a per-agent public route prefix (multi-agent mode)", () => {
    const result = parseSessionCallback({
      ...BASE_CALLBACK,
      url: "https://caller.example.com/eve/agents/researcher/eve/v1/callback/eve%3Aparent-token",
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a callback url whose token segment does not match the token", () => {
    const result = parseSessionCallback({
      ...BASE_CALLBACK,
      url: "https://caller.example.com/eve/agents/researcher/eve/v1/callback/someone-else",
    });

    expect(result.ok).toBe(false);
  });

  it("rejects a private/reserved callback host", () => {
    const result = parseSessionCallback({
      ...BASE_CALLBACK,
      url: "http://169.254.169.254/eve/v1/callback/eve%3Aparent-token",
    });

    expect(result.ok).toBe(false);
  });
});
