import { describe, expect, it } from "vitest";

import type { SignInChallenge } from "#protocol/session-events/families/interaction.js";
import { sameRelayedSignIn } from "./sign-ins.js";

const RUI = { id: "rui", issuer: "vercel", type: "user" } as const;

function signIn(overrides: Partial<SignInChallenge> = {}): SignInChallenge {
  return {
    callbackUrl: "https://v.example/eve/v1/connections/github/callback/attempt-1/token",
    grant: "github/vercel-v",
    name: "github",
    principal: RUI,
    ...overrides,
  };
}

describe("sameRelayedSignIn", () => {
  it("matches the same grant for the same principal from the same deployment", () => {
    expect(
      sameRelayedSignIn(
        signIn(),
        signIn({ callbackUrl: "https://v.example/eve/v1/connections/gh/callback/attempt-2/t" }),
      ),
    ).toBe(true);
  });

  it("never matches another principal's sign-in for the same grant", () => {
    for (const principal of [
      { ...RUI, id: "ben" },
      { ...RUI, issuer: "other" },
      { id: "rui", type: "app" },
      undefined,
    ])
      expect(sameRelayedSignIn(signIn(), signIn({ principal })), JSON.stringify(principal)).toBe(
        false,
      );
  });

  it("never matches across grants, or without one, even for the same connection name", () => {
    expect(sameRelayedSignIn(signIn(), signIn({ grant: "github/other" }))).toBe(false);
    expect(sameRelayedSignIn(signIn(), signIn({ grant: undefined }))).toBe(false);
    expect(sameRelayedSignIn(signIn({ grant: undefined }), signIn({ grant: undefined }))).toBe(
      false,
    );
  });

  it("never matches a sign-in minted by another deployment", () => {
    expect(sameRelayedSignIn(signIn(), signIn({ callbackUrl: "https://w.example/eve/v1/x" }))).toBe(
      false,
    );
    expect(sameRelayedSignIn(signIn(), signIn({ callbackUrl: undefined }))).toBe(false);
  });
});
