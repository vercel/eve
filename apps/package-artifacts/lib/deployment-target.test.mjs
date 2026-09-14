import { describe, expect, test } from "vitest";

import { resolveDeploymentTarget, vercelOidcCredentials } from "./deployment-target.mjs";

const sha = "a".repeat(40);
const baseEnv = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "feature/package",
  VERCEL_GIT_COMMIT_SHA: sha,
  VERCEL_GIT_PULL_REQUEST_ID: "123",
  VERCEL_GIT_REPO_OWNER: "vercel",
  VERCEL_GIT_REPO_SLUG: "eve",
  VERCEL_PROJECT_PRODUCTION_URL: "pkg.eve.dev",
};

describe("Vercel package deployment target", () => {
  test("publishes production main", () => {
    expect(
      resolveDeploymentTarget({
        ...baseEnv,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_PULL_REQUEST_ID: "",
      }),
    ).toEqual({ sourceSha: sha, ref: "main", origin: "https://pkg.eve.dev" });
  });

  test("publishes same-repository pull requests", () => {
    expect(resolveDeploymentTarget(baseEnv)).toEqual({
      sourceSha: sha,
      ref: "123",
      origin: "https://pkg.eve.dev",
    });
  });

  test("rejects local, fork, direct branch, and unsupported deployments", () => {
    expect(resolveDeploymentTarget({})).toBeUndefined();
    expect(resolveDeploymentTarget({ ...baseEnv, VERCEL_GIT_REPO_OWNER: "alice" })).toBeUndefined();
    expect(resolveDeploymentTarget({ ...baseEnv, VERCEL_GIT_PULL_REQUEST_ID: "" })).toBeUndefined();
    expect(resolveDeploymentTarget({ ...baseEnv, VERCEL_ENV: "development" })).toBeUndefined();
  });

  test("requires valid source and package coordinates", () => {
    expect(() => resolveDeploymentTarget({ ...baseEnv, VERCEL_GIT_COMMIT_SHA: "bad" })).toThrow(
      "40-character Git commit SHA",
    );
    expect(() =>
      resolveDeploymentTarget({ ...baseEnv, VERCEL_PROJECT_PRODUCTION_URL: "" }),
    ).toThrow("VERCEL_PROJECT_PRODUCTION_URL");
  });

  test("requires explicit Vercel OIDC credentials", () => {
    expect(
      vercelOidcCredentials({ VERCEL_OIDC_TOKEN: "oidc", BLOB_STORE_ID: "store_123" }),
    ).toEqual({ oidcToken: "oidc", storeId: "store_123" });
    expect(() => vercelOidcCredentials({ BLOB_STORE_ID: "store_123" })).toThrow(
      "VERCEL_OIDC_TOKEN",
    );
    expect(() => vercelOidcCredentials({ VERCEL_OIDC_TOKEN: "oidc" })).toThrow("BLOB_STORE_ID");
  });
});
