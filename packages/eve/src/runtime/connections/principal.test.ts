import { describe, expect, it } from "vitest";

import { contextStorage, ContextContainer } from "#context/container.js";
import { AuthKey, type SessionAuthContext } from "#context/keys.js";
import {
  ConnectionAuthorizationFailedError,
  isConnectionAuthorizationFailedError,
} from "#public/connections/errors.js";
import { principalKey, resolveConnectionPrincipal } from "#runtime/connections/principal.js";
import type { AuthorizationDefinition } from "#runtime/connections/types.js";

function ctxWithAuth(current: SessionAuthContext | null): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(AuthKey, current);
  return ctx;
}

function userAuth(overrides: Partial<SessionAuthContext> = {}): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "jwt-hmac",
    principalId: "user-123",
    principalType: "user",
    ...overrides,
  };
}

const appAuth: AuthorizationDefinition = {
  getToken: async () => ({ token: "t" }),
  principalType: "app",
};

const userAuthDef: AuthorizationDefinition = {
  getToken: async () => ({ token: "t" }),
  principalType: "user",
};

describe("principalKey", () => {
  it("collapses every app principal to the string 'app'", () => {
    expect(principalKey({ type: "app" })).toBe("app");
  });

  it("prefixes user principals with issuer to avoid cross-IdP collisions", () => {
    expect(principalKey({ id: "u1", issuer: "google", type: "user" })).toBe("user:google:u1");
    expect(principalKey({ id: "u1", issuer: "slack", type: "user" })).toBe("user:slack:u1");
  });

  it("differentiates two users from the same issuer", () => {
    const alice = principalKey({ id: "alice", issuer: "idp", type: "user" });
    const bob = principalKey({ id: "bob", issuer: "idp", type: "user" });
    expect(alice).not.toBe(bob);
  });
});

describe("resolveConnectionPrincipal", () => {
  it("returns a fresh app principal for app-typed connections without consulting AuthKey", () => {
    const ctx = ctxWithAuth(null);

    const principal = contextStorage.run(ctx, () => resolveConnectionPrincipal("linear", appAuth));

    expect(principal).toEqual({ type: "app" });
  });

  it("projects the current AuthKey context into a user principal", () => {
    const ctx = ctxWithAuth(userAuth({ issuer: "idp", principalId: "u1" }));

    const principal = contextStorage.run(ctx, () =>
      resolveConnectionPrincipal("linear", userAuthDef),
    );

    expect(principal).toEqual({
      attributes: {},
      id: "u1",
      issuer: "idp",
      type: "user",
    });
  });

  it("falls back to authenticator when issuer is missing", () => {
    const ctx = ctxWithAuth(userAuth({ authenticator: "my-auth", principalId: "u1" }));

    const principal = contextStorage.run(ctx, () =>
      resolveConnectionPrincipal("linear", userAuthDef),
    );

    expect(principal).toMatchObject({
      id: "u1",
      issuer: "my-auth",
      type: "user",
    });
  });

  it("preserves the full SessionAuthContext attributes on the principal", () => {
    const attributes = { email: "a@b.com", roles: ["admin", "viewer"] };
    const ctx = ctxWithAuth(userAuth({ attributes }));

    const principal = contextStorage.run(ctx, () =>
      resolveConnectionPrincipal("linear", userAuthDef),
    );

    expect(principal).toMatchObject({ attributes, type: "user" });
  });

  it("throws principal_required (non-retryable) when AuthKey is null", () => {
    const ctx = ctxWithAuth(null);

    expect.assertions(4);
    try {
      contextStorage.run(ctx, () => resolveConnectionPrincipal("linear", userAuthDef));
    } catch (error) {
      expect(isConnectionAuthorizationFailedError(error)).toBe(true);
      const err = error as ConnectionAuthorizationFailedError;
      expect(err.reason).toBe("principal_required");
      expect(err.retryable).toBe(false);
      expect(err.connectionName).toBe("linear");
    }
  });

  it("throws principal_required when the current auth is non-user (e.g. 'service')", () => {
    const ctx = ctxWithAuth({
      attributes: {},
      authenticator: "oidc",
      principalId: "svc",
      principalType: "service",
    });

    expect(() =>
      contextStorage.run(ctx, () => resolveConnectionPrincipal("linear", userAuthDef)),
    ).toThrow(/principalType "user"/);
  });

  it("accepts an explicit ctx argument and bypasses AsyncLocalStorage", () => {
    const ctx = ctxWithAuth(userAuth({ issuer: "idp", principalId: "u1" }));

    // No contextStorage.run wrapper — the resolver reads the ctx arg
    // directly so callers inside a durable step can pass the
    // deserialized context without re-entering ALS.
    const principal = resolveConnectionPrincipal("linear", userAuthDef, ctx);

    expect(principal).toMatchObject({ id: "u1", issuer: "idp", type: "user" });
  });

  it("resolves from a durable-step-style ctx with AuthKey but no derived SessionKey", () => {
    // Inside a `"use step"` boundary the workflow deserializes only
    // seed keys (AuthKey among them); derived keys like SessionKey are
    // reconstructed by sessionProvider, which only runs inside runStep.
    // This test guards against regressing on that path: the resolver
    // must not depend on SessionKey being populated.
    const ctx = new ContextContainer();
    ctx.set(AuthKey, userAuth({ issuer: "idp", principalId: "durable-user" }));

    const principal = resolveConnectionPrincipal("linear", userAuthDef, ctx);

    expect(principal).toMatchObject({
      id: "durable-user",
      issuer: "idp",
      type: "user",
    });
  });

  it("returns an app principal for app-typed connections even when no context is active", () => {
    // Mirrors ad-hoc CLI / unit-test use: no contextStorage.run,
    // no ctx argument. App-scoped connections must still resolve
    // because they do not depend on session identity.
    const principal = resolveConnectionPrincipal("linear", appAuth);

    expect(principal).toEqual({ type: "app" });
  });

  it("throws principal_required for user-typed connections when no context is active", () => {
    expect.assertions(4);
    try {
      resolveConnectionPrincipal("linear", userAuthDef);
    } catch (error) {
      expect(isConnectionAuthorizationFailedError(error)).toBe(true);
      const err = error as ConnectionAuthorizationFailedError;
      expect(err.reason).toBe("principal_required");
      expect(err.retryable).toBe(false);
      expect(err.message).toMatch(/outside an eve context/);
    }
  });
});
