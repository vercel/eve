import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getVercelSandboxCredentials,
  resolveVercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";

const oidc = vi.hoisted(() => ({
  getVercelOidcToken: vi.fn<typeof import("#compiled/@vercel/oidc/index.js").getVercelOidcToken>(),
}));
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
    vi.restoreAllMocks();
    vi.useRealTimers();
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
      projectId: "prj_env",
      teamId: "team_env",
      token: fresh,
    });
  });

  it("keeps explicit IDs ahead of environment IDs and fresh OIDC claims", async () => {
    const fresh = oidcToken({ exp: nowSeconds() + 3600 });
    vi.stubEnv("VERCEL_OIDC_TOKEN", fresh);
    oidc.getVercelOidcToken.mockResolvedValue(fresh);

    await expect(
      getVercelSandboxCredentials({ projectId: "prj_explicit", teamId: "team_explicit" }),
    ).resolves.toEqual({
      projectId: "prj_explicit",
      teamId: "team_explicit",
      token: fresh,
    });
  });

  it("reads IDs from OIDC claims when configured IDs are incomplete", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", undefined);
    const fresh = oidcToken({ exp: nowSeconds() + 3600 });
    oidc.getVercelOidcToken.mockResolvedValue(fresh);

    await expect(getVercelSandboxCredentials({})).resolves.toEqual({
      projectId: "prj_claims",
      teamId: "team_claims",
      token: fresh,
    });
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

  it.each([
    { secondsLeft: 299, useAccessToken: true },
    { secondsLeft: 301, useAccessToken: false },
  ])(
    "resolves credentials with $secondsLeft seconds left on the ambient OIDC token",
    async ({ secondsLeft, useAccessToken }) => {
      const actual = await vi.importActual<typeof import("#compiled/@vercel/oidc/index.js")>(
        "#compiled/@vercel/oidc/index.js",
      );
      oidc.getVercelOidcToken.mockImplementation(actual.getVercelOidcToken);
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      // Model CI without cached OIDC tokens or a Vercel CLI login. Keep the
      // vendored helper's expiry check and refresh/failure handling real.
      vi.spyOn(fs, "existsSync").mockReturnValue(false);
      vi.spyOn(fs, "readFileSync").mockReturnValue("{}");
      const ambient = oidcToken({ exp: nowSeconds() + secondsLeft });
      vi.stubEnv("VERCEL_OIDC_TOKEN", ambient);
      vi.stubEnv("VERCEL_TOKEN", "token_env");

      await expect(resolveVercelSandboxCredentials({})).resolves.toEqual({
        projectId: "prj_env",
        teamId: "team_env",
        token: useAccessToken ? "token_env" : ambient,
      });
    },
  );

  it("defers to SDK credential lookup when OIDC fails without a fallback credential", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", oidcToken({ exp: nowSeconds() - 60 }));
    oidc.getVercelOidcToken.mockRejectedValue(new Error("Failed to refresh OIDC token"));

    await expect(resolveVercelSandboxCredentials({})).resolves.toEqual({});
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
