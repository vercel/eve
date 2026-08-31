import { afterEach, describe, expect, it, vi } from "vitest";

import { defineWorkspaceSubagents, vercelWorkspaceTarget } from "./workspace-subagents.js";

vi.mock("#compiled/@vercel/oidc/index.js", () => ({
  getVercelOidcToken: vi.fn().mockResolvedValue("oidc-token"),
}));

const member = { name: "triage", path: "agents/tasks/triage" };

afterEach(() => vi.unstubAllEnvs());

describe("defineWorkspaceSubagents", () => {
  it("stamps the workspace definition kind", () => {
    const resolveTarget = () => ({ url: "https://agents.example.com/triage" });
    expect(defineWorkspaceSubagents({ resolveTarget })).toEqual({
      kind: "workspace-subagents",
      resolveTarget,
    });
  });
});

describe("vercelWorkspaceTarget", () => {
  it("uses an unreachable target without preventing eve dev from starting", async () => {
    vi.stubEnv("EVE_DEV", "1");
    vi.stubEnv("VERCEL_URL", undefined);
    const target = await vercelWorkspaceTarget()(member);

    expect(await (target.url as () => Promise<string>)()).toBe("http://127.0.0.1:1");
    await expect(target.auth?.()).resolves.toEqual({ headers: {} });
  });

  it("targets the current preview deployment member route", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "preview.example.com");
    const target = await vercelWorkspaceTarget()(member);

    expect(await (target.url as () => Promise<string>)()).toBe(
      "https://preview.example.com/eve/agents/triage",
    );
    expect(await target.auth?.()).toEqual({
      headers: {
        authorization: "Bearer oidc-token",
        "x-vercel-trusted-oidc-idp-token": "oidc-token",
      },
    });
  });

  it("targets the stable project URL in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "production.example.com");
    const target = await vercelWorkspaceTarget()(member);

    expect(await (target.url as () => Promise<string>)()).toBe(
      "https://production.example.com/eve/agents/triage",
    );
  });
});
