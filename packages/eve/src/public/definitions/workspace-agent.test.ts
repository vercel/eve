import { afterEach, describe, expect, it, vi } from "vitest";

import { defineWorkspaceAgent } from "./workspace-agent.js";

const { getVercelOidcToken } = vi.hoisted(() => ({
  getVercelOidcToken: vi.fn().mockResolvedValue("oidc-token"),
}));

vi.mock("#compiled/@vercel/oidc/index.js", () => ({ getVercelOidcToken }));

afterEach(() => {
  getVercelOidcToken.mockClear();
  vi.unstubAllEnvs();
});

describe("defineWorkspaceAgent", () => {
  it("selects Vercel transport in a Vercel environment", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "preview.example.com");
    const subagent = defineWorkspaceAgent({ name: "research" });

    expect(subagent).toMatchObject({ description: "", kind: "remote", path: "/eve/v1/session" });
    expect(await (subagent.url as () => Promise<string>)()).toBe(
      "https://preview.example.com/research",
    );
    await expect(subagent.auth?.()).resolves.toEqual({
      headers: {
        authorization: "Bearer oidc-token",
        "x-vercel-trusted-oidc-idp-token": "oidc-token",
      },
    });
  });

  it("uses the local Vercel router without deployment credentials in development", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "development");
    vi.stubEnv("VERCEL_URL", "localhost:3000");
    const subagent = defineWorkspaceAgent({ name: "research" });

    expect((subagent.url as () => string)()).toBe("http://localhost:3000/research");
    await expect(subagent.auth?.()).resolves.toEqual({ headers: {} });
    expect(getVercelOidcToken).not.toHaveBeenCalled();
  });

  it.each([
    {
      callerRoutePrefix: "/eve/agents/support",
      expected: "http://localhost:3000/eve/agents/research",
      environment: "development",
      host: "localhost:3000",
    },
    {
      callerRoutePrefix: "/internal/agents/support",
      expected: "https://preview.example.com/internal/agents/research",
      environment: "preview",
      host: "preview.example.com",
    },
  ])(
    "preserves the caller's route namespace in $environment",
    async ({ callerRoutePrefix, environment, expected, host }) => {
      vi.stubEnv("EVE_PUBLIC_ROUTE_PREFIX", callerRoutePrefix);
      vi.stubEnv("VERCEL", "1");
      vi.stubEnv("VERCEL_ENV", environment);
      vi.stubEnv("VERCEL_URL", host);

      const subagent = defineWorkspaceAgent({ name: "research" });

      expect((subagent.url as () => string)()).toBe(expected);
    },
  );

  it("requires an explicit transport outside Vercel", async () => {
    vi.stubEnv("VERCEL", undefined);
    const subagent = defineWorkspaceAgent({ name: "research" });

    expect(() => (subagent.url as () => string)()).toThrow(
      "No default workspace-agent transport is available",
    );
  });

  it("uses an explicit transport instead of the environment default", async () => {
    vi.stubEnv("VERCEL", undefined);
    const auth = vi.fn(async () => ({ headers: { authorization: "Bearer custom" } }));
    const subagent = defineWorkspaceAgent({
      name: "research",
      transport: {
        auth,
        headers: { "x-workspace": "custom" },
        url: "https://research.internal",
      },
    });

    expect(subagent).toMatchObject({
      auth,
      headers: { "x-workspace": "custom" },
      url: "https://research.internal",
    });
  });
});
