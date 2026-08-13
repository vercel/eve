import { describe, expect, it } from "vitest";
import {
  assertSafeBuzzAuthorGate,
  eveChildEnvironment,
  SHARED_PRINCIPAL_OPT_IN,
} from "./environment.js";

describe("Buzz author gate", () => {
  it("accepts owner-only and nobody modes", () => {
    expect(() => assertSafeBuzzAuthorGate({ BUZZ_ACP_RESPOND_TO: "owner-only" })).not.toThrow();
    expect(() => assertSafeBuzzAuthorGate({ BUZZ_ACP_RESPOND_TO: "nobody" })).not.toThrow();
  });

  it("rejects shared and unknown modes by default", () => {
    expect(() => assertSafeBuzzAuthorGate({ BUZZ_ACP_RESPOND_TO: "allowlist" })).toThrow(
      "--allow-shared-principal",
    );
    expect(() => assertSafeBuzzAuthorGate({ BUZZ_ACP_RESPOND_TO: "anyone" })).toThrow(
      'gate is "anyone"',
    );
    expect(() => assertSafeBuzzAuthorGate({})).toThrow("not available");
  });

  it("accepts a shared or unknown mode only after explicit opt-in", () => {
    expect(() =>
      assertSafeBuzzAuthorGate({
        BUZZ_ACP_RESPOND_TO: "anyone",
        [SHARED_PRINCIPAL_OPT_IN]: "1",
      }),
    ).not.toThrow();
    expect(() => assertSafeBuzzAuthorGate({ [SHARED_PRINCIPAL_OPT_IN]: "1" })).not.toThrow();
  });
});

describe("eve child environment", () => {
  it("removes connector-only security state without mutating the parent environment", () => {
    const parent = {
      BUZZ_PRIVATE_KEY: "private",
      BUZZ_AUTH_TAG: "auth",
      BUZZ_API_TOKEN: "token",
      BUZZ_ACP_RESPOND_TO: "owner-only",
      BUZZ_ACP_RESPOND_TO_ALLOWLIST: "sender",
      EVE_BUZZ_ALLOW_SHARED_PRINCIPAL: "1",
      BUZZ_RELAY_URL: "wss://relay.example.com",
      PATH: "/bin",
    };

    expect(eveChildEnvironment(parent)).toEqual({
      BUZZ_RELAY_URL: "wss://relay.example.com",
      PATH: "/bin",
    });
    expect(parent.BUZZ_PRIVATE_KEY).toBe("private");
  });
});
