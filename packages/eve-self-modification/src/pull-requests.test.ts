import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSelfModificationConfig } from "./config.js";
import {
  assertSelfModificationPullRequestsAvailable,
  canUseSelfModificationPullRequests,
  resolvePersonalAccessToken,
} from "./pull-requests.js";

const SOURCE = {
  repository: "github.com/acme/agent",
  revision: "1".repeat(40),
  rootDirectory: ".",
};

function pullRequests() {
  const config = resolveSelfModificationConfig({
    change: { behavior: "review", branch: "main" },
    source: { git: { repository: "github.com/acme/agent" } },
  });
  if (config.pullRequests === undefined) throw new Error("Missing pull request configuration.");
  return config.pullRequests;
}

afterEach(() => vi.unstubAllEnvs());

describe("deployed self-modification availability", () => {
  it("accepts trusted source metadata for the configured repository", () => {
    expect(
      assertSelfModificationPullRequestsAvailable({ pullRequests: pullRequests(), source: SOURCE }),
    ).toEqual(SOURCE);
  });

  it("rejects unavailable or mismatched deployment source", () => {
    expect(() =>
      assertSelfModificationPullRequestsAvailable({ pullRequests: pullRequests(), source: null }),
    ).toThrow(/requires deployment source metadata/u);
    expect(() =>
      assertSelfModificationPullRequestsAvailable({
        pullRequests: pullRequests(),
        source: { ...SOURCE, repository: "github.com/other/agent" },
      }),
    ).toThrow(/does not match/u);
  });

  it("resolves the personal access token from the fixed environment variable", () => {
    vi.stubEnv("EVE_SELF_MODIFICATION_GITHUB_TOKEN", " github-token ");
    expect(resolvePersonalAccessToken()).toBe("github-token");

    vi.stubEnv("EVE_SELF_MODIFICATION_GITHUB_TOKEN", "");
    expect(() => resolvePersonalAccessToken()).toThrow(
      /EVE_SELF_MODIFICATION_GITHUB_TOKEN is required/u,
    );
  });

  it("exposes pull requests only with source metadata and a credential", () => {
    expect(
      canUseSelfModificationPullRequests({ pullRequests: pullRequests(), source: SOURCE }),
    ).toBe(false);

    vi.stubEnv("EVE_SELF_MODIFICATION_GITHUB_TOKEN", "github-token");
    expect(
      canUseSelfModificationPullRequests({ pullRequests: pullRequests(), source: SOURCE }),
    ).toBe(true);
    expect(canUseSelfModificationPullRequests({ pullRequests: pullRequests(), source: null })).toBe(
      false,
    );
  });
});
