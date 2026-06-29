import { describe, expect, it } from "vitest";

import {
  resolveAuthorizationCallbackUrl,
  stampChallengeDisplayName,
} from "#runtime/connections/scoped-authorization.js";
import type { AuthorizationDefinition, TokenResult } from "#runtime/connections/types.js";

function interactiveAuth(
  input: { displayName?: string; connector?: string } = {},
): AuthorizationDefinition {
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
  if (input.displayName === undefined && input.connector === undefined) return auth;
  const overrides: {
    displayName?: AuthorizationDefinition["displayName"];
    vercelConnect?: NonNullable<AuthorizationDefinition["vercelConnect"]>;
  } = {};
  if (input.connector !== undefined) {
    overrides.vercelConnect = { connector: input.connector };
  }
  if (input.displayName !== undefined) {
    overrides.displayName = input.displayName;
  }
  return { ...auth, ...overrides };
}

describe("stampChallengeDisplayName", () => {
  it("prefers the definition-level displayName over the strategy's", () => {
    const challenge = { displayName: "Strategy Default", url: "https://idp.example/auth" };

    expect(
      stampChallengeDisplayName(challenge, interactiveAuth({ displayName: "Salesforce" })),
    ).toEqual({
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

describe("resolveAuthorizationCallbackUrl", () => {
  it.each([
    [
      "http://127.0.0.1:2000/eve/v1/connections/notion/callback/wrun_123%3Aauth",
      "http://localhost:2000/eve/v1/connections/notion/callback/wrun_123%3Aauth",
    ],
    [
      "http://[::1]:2000/eve/v1/connections/notion/callback/wrun_123%3Aauth",
      "http://localhost:2000/eve/v1/connections/notion/callback/wrun_123%3Aauth",
    ],
  ])("uses localhost for a Vercel Connect callback at %s", (callbackUrl, expectedUrl) => {
    expect(
      resolveAuthorizationCallbackUrl({
        authorization: interactiveAuth({ connector: "mcp.notion.com/notion" }),
        callbackUrl,
      }),
    ).toBe(expectedUrl);
  });

  it("preserves a custom authorization callback URL", () => {
    const callbackUrl = "http://127.0.0.1:2000/callback";

    expect(resolveAuthorizationCallbackUrl({ authorization: interactiveAuth(), callbackUrl })).toBe(
      callbackUrl,
    );
  });

  it("preserves an HTTPS Vercel Connect callback URL", () => {
    const callbackUrl = "https://agent.example.com/callback";

    expect(
      resolveAuthorizationCallbackUrl({
        authorization: interactiveAuth({ connector: "mcp.notion.com/notion" }),
        callbackUrl,
      }),
    ).toBe(callbackUrl);
  });
});
