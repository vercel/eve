import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakeVercelOidcToken } from "#internal/testing/vercel-oidc-token.js";
import {
  decodeVercelOidcTokenClaims,
  resolveVercelProjectIdFromEnvironment,
} from "#shared/vercel-project.js";

const EMPTY_CLAIMS = { ownerId: undefined, projectId: undefined };

describe("decodeVercelOidcTokenClaims", () => {
  it("decodes owner and project claims", () => {
    const claims = decodeVercelOidcTokenClaims(
      createFakeVercelOidcToken({ owner_id: "team_1", project_id: "prj_123" }),
    );

    expect(claims).toEqual({ ownerId: "team_1", projectId: "prj_123" });
  });

  it("decodes missing or non-string claims as undefined fields", () => {
    expect(decodeVercelOidcTokenClaims(createFakeVercelOidcToken({ project_id: 42 }))).toEqual(
      EMPTY_CLAIMS,
    );
  });

  it("decodes values that are not JWTs to empty claims", () => {
    expect(decodeVercelOidcTokenClaims("not-a-jwt")).toEqual(EMPTY_CLAIMS);
    expect(decodeVercelOidcTokenClaims("a.!!!.c")).toEqual(EMPTY_CLAIMS);
    expect(decodeVercelOidcTokenClaims(`a.${Buffer.from("[]").toString("base64url")}.c`)).toEqual(
      EMPTY_CLAIMS,
    );
    expect(decodeVercelOidcTokenClaims(`a.${Buffer.from("null").toString("base64url")}.c`)).toEqual(
      EMPTY_CLAIMS,
    );
  });
});

describe("resolveVercelProjectIdFromEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the VERCEL_PROJECT_ID env var", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_env");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createFakeVercelOidcToken({ project_id: "prj_token" }));

    expect(resolveVercelProjectIdFromEnvironment()).toBe("prj_env");
  });

  it("falls back to the OIDC token project claim", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", createFakeVercelOidcToken({ project_id: "prj_token" }));

    expect(resolveVercelProjectIdFromEnvironment()).toBe("prj_token");
  });

  it("returns undefined when neither source names a project", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");

    expect(resolveVercelProjectIdFromEnvironment()).toBeUndefined();
  });
});
