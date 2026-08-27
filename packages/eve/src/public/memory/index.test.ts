import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultNamespace, type MemoryScopeContext } from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";

const baseContext: MemoryScopeContext = {
  abortSignal: new AbortController().signal,
  channel: { kind: "eve" },
  session: { auth: { current: null, initiator: null }, id: "session_1" },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("memory namespaces and scopes", () => {
  it("derives stable local namespaces without persisting the raw application root", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    const input = { appRoot: "/Users/example/private/app", node: "__root__", slot: "profile" };

    const first = defaultNamespace(input);
    const second = defaultNamespace(input);

    expect(first).toBe(second);
    expect(first).not.toContain(input.appRoot);
    expect(JSON.parse(first)).toMatchObject([
      "eve-memory-default-namespace-v1",
      "local",
      expect.any(String),
      "__root__",
      "profile",
    ]);
  });

  it("separates production and preview namespaces by stable deployment coordinates", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature/memory");
    const preview = defaultNamespace({ appRoot: "/app", node: "__root__", slot: "profile" });

    vi.stubEnv("VERCEL_ENV", "production");
    const production = defaultNamespace({
      appRoot: "/app",
      node: "__root__",
      slot: "profile",
    });

    expect(JSON.parse(preview)).toEqual([
      "eve-memory-default-namespace-v1",
      "vercel",
      "prj_123",
      "preview",
      "feature/memory",
      "__root__",
      "profile",
    ]);
    expect(preview).not.toBe(production);
  });

  it("disables anonymous and runtime principals and normalizes local development", () => {
    const context = (principalType: string, principalId = "principal") => ({
      ...baseContext,
      session: {
        ...baseContext.session,
        auth: {
          current: {
            attributes: {},
            authenticator: principalType,
            principalId,
            principalType,
          },
          initiator: null,
        },
      },
    });

    expect(byPrincipal(baseContext)).toBeNull();
    expect(byPrincipal(context("anonymous"))).toBeNull();
    expect(byPrincipal(context("runtime"))).toBeNull();
    expect(byPrincipal(context("local-dev", "machine-specific"))).toBe("local-dev");
  });

  it("includes the authenticated principal coordinates without delimiter flattening", () => {
    const context: MemoryScopeContext = {
      ...baseContext,
      session: {
        ...baseContext.session,
        auth: {
          current: {
            attributes: {},
            authenticator: "oidc:primary",
            issuer: "https://issuer.example",
            principalId: "user:123",
            principalType: "user",
          },
          initiator: null,
        },
      },
    };

    expect(JSON.parse(byPrincipal(context)!)).toEqual([
      "user",
      "oidc:primary",
      "https://issuer.example",
      "user:123",
    ]);
  });
});
