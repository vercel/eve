import { describe, expect, it, vi } from "vitest";

import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";

import { resolveVerifiedRemoteDevelopmentClient } from "./verified-remote-client.js";

const target = await resolveTestVercelTarget({
  host: "example.vercel.app",
  projectId: "prj_example",
});

describe("resolveVerifiedRemoteDevelopmentClient", () => {
  it("resolves scoped credentials per request after exact deployment verification", async () => {
    const resolveDevelopmentOidcToken = vi.fn(async () => ({
      kind: "resolved" as const,
      token: " fresh-token ",
    }));
    const { options } = await resolveVerifiedRemoteDevelopmentClient({
      serverUrl: "https://example.vercel.app/path",
      workspaceRoot: "/workspace",
      deps: {
        resolveVercelDeployment: async () => ({ kind: "resolved", target }),
        resolveDevelopmentOidcToken,
      },
    });

    expect(options.redirect).toBe("manual");
    // The OIDC token rides the higher-level vercelOidc auth; the client expands
    // it into the Authorization + trusted-OIDC headers (covered in client.test.ts).
    if (options.auth === undefined || !("vercelOidc" in options.auth)) {
      throw new Error("Expected vercelOidc auth.");
    }
    const { token } = options.auth.vercelOidc;
    expect(typeof token === "function" ? await token() : token).toBe("fresh-token");
    expect(resolveDevelopmentOidcToken).toHaveBeenCalledWith({
      ownerId: "team_test",
      projectId: "prj_example",
    });
  });

  it("exposes the token failure while preserving anonymous fallback", async () => {
    const failure = {
      kind: "target-mismatch",
      mismatchedClaims: ["owner_id", "project_id"],
    } as const;
    const { options, lastOidcTokenFailure } = await resolveVerifiedRemoteDevelopmentClient({
      serverUrl: "https://example.vercel.app/path",
      workspaceRoot: "/workspace",
      deps: {
        resolveVercelDeployment: async () => ({ kind: "resolved", target }),
        resolveDevelopmentOidcToken: async () => failure,
      },
    });

    if (options.auth === undefined || !("vercelOidc" in options.auth)) {
      throw new Error("Expected vercelOidc auth.");
    }
    const { token } = options.auth.vercelOidc;
    expect(typeof token === "function" ? await token() : token).toBe("");
    expect(lastOidcTokenFailure()).toEqual(failure);
  });

  it("keeps an unverified remote anonymous", async () => {
    const resolveDevelopmentOidcToken = vi.fn(async () => ({
      kind: "resolved" as const,
      token: "ambient-token",
    }));
    const { options } = await resolveVerifiedRemoteDevelopmentClient({
      serverUrl: "https://arbitrary.example.com",
      workspaceRoot: "/workspace",
      deps: {
        resolveVercelDeployment: async () => ({ kind: "not-found" }),
        resolveDevelopmentOidcToken,
      },
    });

    expect(typeof options.headers).toBe("function");
    if (typeof options.headers !== "function") throw new Error("Expected dynamic headers.");
    await expect(options.headers()).resolves.toEqual({});
    expect(resolveDevelopmentOidcToken).not.toHaveBeenCalled();
  });
});
