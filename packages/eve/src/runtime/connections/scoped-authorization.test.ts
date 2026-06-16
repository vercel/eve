import { describe, expect, it } from "vitest";

import { stampChallengeDisplayName } from "#runtime/connections/scoped-authorization.js";
import type { AuthorizationDefinition, TokenResult } from "#runtime/connections/types.js";

function interactiveAuth(displayName?: string): AuthorizationDefinition {
  const auth: AuthorizationDefinition = {
    principalType: "user",
    async getToken(): Promise<TokenResult> {
      return { token: "tok" };
    },
    async startAuthorization() {
      return { challenge: { url: "https://idp.example/auth" } };
    },
    async completeAuthorization(): Promise<TokenResult> {
      return { token: "fresh" };
    },
  };
  if (displayName === undefined) return auth;
  return { ...auth, displayName };
}

describe("stampChallengeDisplayName", () => {
  it("prefers the definition-level displayName over the strategy's", () => {
    const challenge = { displayName: "Strategy Default", url: "https://idp.example/auth" };

    expect(stampChallengeDisplayName(challenge, interactiveAuth("Salesforce"))).toEqual({
      displayName: "Salesforce",
      url: "https://idp.example/auth",
    });
  });

  it("keeps the strategy-stamped displayName when the definition has none", () => {
    const challenge = { displayName: "Salesforce", url: "https://idp.example/auth" };

    expect(stampChallengeDisplayName(challenge, interactiveAuth())).toBe(challenge);
  });

  it("returns the same challenge object when nothing resolves", () => {
    const challenge = { url: "https://idp.example/auth" };

    expect(stampChallengeDisplayName(challenge, interactiveAuth())).toBe(challenge);
  });
});
