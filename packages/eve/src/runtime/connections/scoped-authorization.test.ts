import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { readCachedToken } from "#runtime/connections/authorization-tokens.js";
import {
  evictScopedToken,
  resolveAuthorizationCallbackUrl,
  resolveScopedToken,
  stampChallengeDisplayName,
} from "#runtime/connections/scoped-authorization.js";
import type { AuthorizationDefinition, TokenResult } from "#shared/connection-types.js";

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

describe("resolveScopedToken", () => {
  it("coalesces concurrent getToken calls for the same scope and principal", async () => {
    let release!: (value: TokenResult) => void;
    const getToken = vi.fn(
      () =>
        new Promise<TokenResult>((resolve) => {
          release = resolve;
        }),
    );
    const ctx = new ContextContainer();
    const input = {
      authorization: { getToken, principalType: "app" as const },
      connection: { url: "" },
      scope: "slack",
    };

    const [first, second] = await contextStorage.run(ctx, async () => {
      const a = resolveScopedToken(input);
      const b = resolveScopedToken(input);
      release({ token: "tok_1" });
      return await Promise.all([a, b]);
    });

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ token: "tok_1" });
    expect(second).toEqual({ token: "tok_1" });
  });

  it("shares a rejected fetch across concurrent callers and does not cache the failure", async () => {
    const firstAttempt = Promise.withResolvers<TokenResult>();
    const getToken = vi
      .fn<() => Promise<TokenResult>>()
      .mockReturnValueOnce(firstAttempt.promise)
      .mockResolvedValueOnce({ token: "tok_2" });
    const ctx = new ContextContainer();
    const input = {
      authorization: { getToken, principalType: "app" as const },
      connection: { url: "" },
      scope: "slack",
    };

    await contextStorage.run(ctx, async () => {
      const a = resolveScopedToken(input);
      const b = resolveScopedToken(input);
      firstAttempt.reject(new Error("transient"));
      await expect(a).rejects.toThrow("transient");
      await expect(b).rejects.toThrow("transient");
      await expect(resolveScopedToken(input)).resolves.toEqual({ token: "tok_2" });
    });

    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce concurrent calls across different scopes, instanceIds, or principals", async () => {
    const getToken = vi.fn(
      async ({
        principal,
      }: {
        readonly principal: { readonly type: string; readonly id?: string };
      }) => ({
        token: `tok_${principal.id ?? "app"}`,
      }),
    );
    const ctx = new ContextContainer();
    ctx.set(AuthKey, {
      attributes: {},
      authenticator: "idp",
      principalId: "alice",
      principalType: "user",
    });

    await contextStorage.run(ctx, async () => {
      const [scopeA, scopeB, instA, aliceTok, bobTok] = await Promise.all([
        resolveScopedToken({
          authorization: { getToken, principalType: "app" },
          connection: { url: "" },
          scope: "slack",
        }),
        resolveScopedToken({
          authorization: { getToken, principalType: "app" },
          connection: { url: "" },
          scope: "linear",
        }),
        resolveScopedToken({
          authorization: { getToken, principalType: "app" },
          connection: { url: "" },
          instanceId: "inst-1",
          scope: "slack",
        }),
        resolveScopedToken({
          authorization: { getToken, principalType: "user" },
          connection: { url: "" },
          scope: "github",
        }),
        resolveScopedToken({
          authorization: { getToken, principalType: "user" },
          boundResponder: {
            attributes: {},
            authenticator: "idp",
            principalId: "bob",
            principalType: "user",
          },
          connection: { url: "" },
          scope: "github",
        }),
      ]);

      expect(scopeA.token).toBe("tok_app");
      expect(scopeB.token).toBe("tok_app");
      expect(instA.token).toBe("tok_app");
      expect(aliceTok.token).toBe("tok_alice");
      expect(bobTok.token).toBe("tok_bob");
    });

    expect(getToken).toHaveBeenCalledTimes(5);
  });

  it("does not write back an evicted in-flight token or interfere with a newer flight", async () => {
    const first = Promise.withResolvers<TokenResult>();
    const second = Promise.withResolvers<TokenResult>();
    const getToken = vi
      .fn<() => Promise<TokenResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const ctx = new ContextContainer();
    const input = {
      authorization: { getToken, principalType: "app" as const },
      connection: { url: "" },
      scope: "slack",
    };

    await contextStorage.run(ctx, async () => {
      const stale = resolveScopedToken(input);
      await evictScopedToken(input);
      const fresh = resolveScopedToken(input);

      first.resolve({ token: "tok_stale" });
      await expect(stale).resolves.toEqual({ token: "tok_stale" });
      expect(readCachedToken(ctx, "slack", "app")).toBeUndefined();

      second.resolve({ token: "tok_fresh" });
      await expect(fresh).resolves.toEqual({ token: "tok_fresh" });
      expect(readCachedToken(ctx, "slack", "app")).toEqual({ token: "tok_fresh" });
    });

    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("drops in-flight entries when ctx.clearVirtualContext() resets the step", async () => {
    const first = Promise.withResolvers<TokenResult>();
    const second = Promise.withResolvers<TokenResult>();
    const getToken = vi
      .fn<() => Promise<TokenResult>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const ctx = new ContextContainer();
    const input = {
      authorization: { getToken, principalType: "app" as const },
      connection: { url: "" },
      scope: "slack",
    };

    await contextStorage.run(ctx, async () => {
      const earlierStep = resolveScopedToken(input);
      ctx.clearVirtualContext();
      const nextStep = resolveScopedToken(input);

      first.resolve({ token: "tok_old_step" });
      await expect(earlierStep).resolves.toEqual({ token: "tok_old_step" });
      expect(readCachedToken(ctx, "slack", "app")).toBeUndefined();

      second.resolve({ token: "tok_new_step" });
      await expect(nextStep).resolves.toEqual({ token: "tok_new_step" });
      expect(readCachedToken(ctx, "slack", "app")).toEqual({ token: "tok_new_step" });
    });

    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it("does not emit an unhandledRejection when a single caller rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const ctx = new ContextContainer();
      await contextStorage.run(ctx, async () => {
        await expect(
          resolveScopedToken({
            authorization: {
              getToken: async () => {
                throw new Error("boom");
              },
              principalType: "app",
            },
            connection: { url: "" },
            scope: "slack",
          }),
        ).rejects.toThrow("boom");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
