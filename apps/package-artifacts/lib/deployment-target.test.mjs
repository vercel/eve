import { describe, expect, test, vi } from "vitest";

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
const currentPull = {
  number: 123,
  state: "open",
  base: { ref: "main" },
  head: { ref: "feature/package", repo: { full_name: "vercel/eve" }, sha },
};

function githubResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(value),
  };
}

describe("Vercel package deployment target", () => {
  test("publishes production main", async () => {
    await expect(
      resolveDeploymentTarget({
        ...baseEnv,
        VERCEL_ENV: "production",
        VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_GIT_PULL_REQUEST_ID: "",
      }),
    ).resolves.toEqual({ sourceSha: sha, ref: "main", origin: "https://pkg.eve.dev" });
  });

  test("publishes same-repository pull requests from the system PR ID", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(githubResponse(currentPull));
    await expect(resolveDeploymentTarget(baseEnv, fetchImplementation)).resolves.toEqual({
      sourceSha: sha,
      ref: "123",
      origin: "https://pkg.eve.dev",
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/repos/vercel/eve/pulls/123",
      expect.any(Object),
    );
  });

  test("resolves a PR when its branch deployment started before the PR existed", async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(githubResponse([currentPull]));
    await expect(
      resolveDeploymentTarget({ ...baseEnv, VERCEL_GIT_PULL_REQUEST_ID: "" }, fetchImplementation),
    ).resolves.toEqual({ sourceSha: sha, ref: "123", origin: "https://pkg.eve.dev" });
    const [url] = fetchImplementation.mock.calls[0];
    expect(url).toContain("head=vercel%3Afeature%2Fpackage");
  });

  test("rejects local, fork, direct branch, stale, and non-main PR deployments", async () => {
    await expect(resolveDeploymentTarget({})).resolves.toBeUndefined();
    await expect(
      resolveDeploymentTarget({ ...baseEnv, VERCEL_GIT_REPO_OWNER: "alice" }),
    ).resolves.toBeUndefined();
    await expect(
      resolveDeploymentTarget(
        { ...baseEnv, VERCEL_GIT_PULL_REQUEST_ID: "" },
        vi.fn().mockResolvedValue(githubResponse([])),
      ),
    ).resolves.toBeUndefined();

    for (const pull of [
      { ...currentPull, state: "closed" },
      { ...currentPull, base: { ref: "release" } },
      { ...currentPull, head: { ...currentPull.head, sha: "b".repeat(40) } },
    ]) {
      await expect(
        resolveDeploymentTarget(baseEnv, vi.fn().mockResolvedValue(githubResponse(pull))),
      ).resolves.toBeUndefined();
    }
  });

  test("requires valid publishing coordinates", async () => {
    await expect(
      resolveDeploymentTarget({ ...baseEnv, VERCEL_GIT_COMMIT_SHA: "bad" }),
    ).rejects.toThrow("40-character Git commit SHA");
    await expect(
      resolveDeploymentTarget({ ...baseEnv, VERCEL_PROJECT_PRODUCTION_URL: "" }),
    ).rejects.toThrow("VERCEL_PROJECT_PRODUCTION_URL");
    await expect(
      resolveDeploymentTarget(baseEnv, vi.fn().mockResolvedValue(githubResponse({}, 503))),
    ).rejects.toThrow("GitHub returned 503");
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
