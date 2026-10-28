import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { continueTurnAuth } from "#execution/session/principal.js";

const alice: SessionAuthContext = {
  attributes: { scope: "read" },
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

describe("continueTurnAuth", () => {
  it("updates the claims of the turn's own principal", () => {
    const refreshed = { ...alice, attributes: { scope: "write" } };
    expect(continueTurnAuth(alice, refreshed)).toBe(refreshed);
  });

  it("keeps the turn's identity for input without auth", () => {
    expect(continueTurnAuth(alice, undefined)).toBe(alice);
  });

  it.each([
    ["another principal", { ...alice, principalId: "bob" }],
    ["another issuer", { ...alice, issuer: "https://other.example" }],
    ["an anonymous caller", null],
  ])("refuses a message from %s", (_, auth) => {
    expect(() => continueTurnAuth(alice, auth)).toThrow(
      "A message from another principal cannot join a running turn.",
    );
  });
});
