import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeVercelOidcTokenClaims,
  resolveVercelProjectIdFromEnvironment,
} from "#shared/vercel-project.js";

function createOidcToken(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.signature`;
}

describe("decodeVercelOidcTokenClaims", () => {
  it("decodes owner and project claims", () => {
    const claims = decodeVercelOidcTokenClaims(
      createOidcToken({ owner_id: "team_1", project_id: "prj_123" }),
    );

    expect(claims).toEqual({ ownerId: "team_1", projectId: "prj_123" });
  });

  it("returns undefined claim fields for missing or non-string values", () => {
    const claims = decodeVercelOidcTokenClaims(createOidcToken({ project_id: 42 }));

    expect(claims).toEqual({ ownerId: undefined, projectId: undefined });
  });

  it("returns undefined for values that are not decodable JWTs", () => {
    expect(decodeVercelOidcTokenClaims("not-a-jwt")).toBeUndefined();
    expect(decodeVercelOidcTokenClaims("a.!!!.c")).toBeUndefined();
    expect(decodeVercelOidcTokenClaims(`a.${Buffer.from("[]").toString("base64url")}.c`)).toEqual({
      ownerId: undefined,
      projectId: undefined,
    });
    expect(
      decodeVercelOidcTokenClaims(`a.${Buffer.from("null").toString("base64url")}.c`),
    ).toBeUndefined();
  });
});

describe("resolveVercelProjectIdFromEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the VERCEL_PROJECT_ID env var", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createOidcToken({ project_id: "prj_token" }));

    expect(resolveVercelProjectIdFromEnvironment()).toBe("prj_env");
  });

  it("falls back to the OIDC token project claim", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createOidcToken({ project_id: "prj_token" }));

    expect(resolveVercelProjectIdFromEnvironment()).toBe("prj_token");
  });

  it("returns undefined when neither source names a project", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");

    expect(resolveVercelProjectIdFromEnvironment()).toBeUndefined();
  });
});
