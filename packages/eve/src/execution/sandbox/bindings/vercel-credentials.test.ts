import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getVercelSandboxCredentials } from "#execution/sandbox/bindings/vercel-credentials.js";

const oidc = vi.hoisted(() => ({ getVercelOidcToken: vi.fn<() => Promise<string>>() }));
vi.mock("#compiled/@vercel/oidc/index.js", () => oidc);

function oidcToken(claims: { readonly exp: number }): string {
  const payload = { ...claims, owner_id: "team_claims", project_id: "prj_claims" };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe("getVercelSandboxCredentials", () => {
  beforeEach(() => {
    oidc.getVercelOidcToken.mockReset();
    vi.stubEnv("VERCEL_OIDC_TOKEN", undefined);
    vi.stubEnv("VERCEL_ORG_ID", undefined);
    vi.stubEnv("VERCEL_TEAM_ID", "team_env");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");
    vi.stubEnv("VERCEL_TOKEN", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses an explicit token without consulting OIDC", async () => {
    await expect(getVercelSandboxCredentials({ token: "token_explicit" })).resolves.toEqual({
      projectId: "prj_env",
      teamId: "team_env",
      token: "token_explicit",
    });
    expect(oidc.getVercelOidcToken).not.toHaveBeenCalled();
  });

  it("resolves the ambient OIDC token through the helper instead of sending it as-is", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken({ exp: nowSeconds() - 60 }));
    const fresh = oidcToken({ exp: nowSeconds() + 3600 });
    oidc.getVercelOidcToken.mockResolvedValue(fresh);

    await expect(getVercelSandboxCredentials({})).resolves.toEqual({
      projectId: "prj_claims",
      teamId: "team_claims",
      token: fresh,
    });
    expect(oidc.getVercelOidcToken).toHaveBeenCalledWith({ project: "prj_env", team: "team_env" });
  });

  it("falls back to VERCEL_TOKEN when the ambient OIDC token cannot be used", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken({ exp: nowSeconds() - 60 }));
    vi.stubEnv("VERCEL_TOKEN", "token_env");
    oidc.getVercelOidcToken.mockRejectedValue(new Error("Failed to refresh OIDC token"));

    await expect(getVercelSandboxCredentials({})).resolves.toEqual({
      projectId: "prj_env",
      teamId: "team_env",
      token: "token_env",
    });
  });

  it("surfaces the OIDC failure when no other credential is configured", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken({ exp: nowSeconds() - 60 }));
    oidc.getVercelOidcToken.mockRejectedValue(new Error("Failed to refresh OIDC token"));

    await expect(getVercelSandboxCredentials({})).rejects.toThrow("Failed to refresh OIDC token");
  });

  it("uses VERCEL_TOKEN without consulting OIDC when no OIDC token is present", async () => {
    vi.stubEnv("VERCEL_TOKEN", "token_env");

    await expect(getVercelSandboxCredentials({})).resolves.toEqual({
      projectId: "prj_env",
      teamId: "team_env",
      token: "token_env",
    });
    expect(oidc.getVercelOidcToken).not.toHaveBeenCalled();
  });
});
