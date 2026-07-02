import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearGitHubInstallationTokenCache,
  seedGitHubInstallationTokenForTests,
} from "#public/channels/github/auth.js";
import { buildGitHubPullRequestContext } from "#public/channels/github/pr-context.js";

const credentials = {
  appId: "test-app",
};

beforeEach(() => {
  clearGitHubInstallationTokenCache();
  seedGitHubInstallationTokenForTests({
    apiBaseUrl: "https://github.test",
    installationId: 55,
    token: "ghs_test",
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    additions: 12,
    base: {
      ref: "main",
      repo: { default_branch: "main", full_name: "vercel/eve" },
      sha: "base-sha",
    },
    body: "This PR adds GitHub context.",
    changed_files: 2,
    deletions: 3,
    draft: false,
    head: {
      ref: "feature/github",
      repo: { full_name: "octocat/eve" },
      sha: "head-sha",
    },
    html_url: "https://github.test/vercel/eve/pull/7",
    mergeable: true,
    number: 7,
    state: "open",
    title: "Add GitHub context",
    user: { id: 42, login: "octocat", type: "User" },
    ...overrides,
  };
}

function text(messages: readonly string[] | undefined): string {
  return messages?.[0] ?? "";
}

function build(fetchMock: typeof fetch, config?: { excludedFiles?: readonly string[] }) {
  return buildGitHubPullRequestContext({
    api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
    config,
    credentials,
    installationId: 55,
    owner: "vercel",
    pullRequestNumber: 7,
    repo: "eve",
  });
}

/**
 * SHA pinning for webhook-driven PR turns.
 *
 * Dispatch copies `state.headSha` and `state.baseSha` from the webhook into
 * {@link buildGitHubPullRequestContext} so injected diffs and sandbox checkout
 * refer to the same commit.
 *
 * Timing gap this covers (single delivery):
 *   T0  Webhook arrives for commit ABC → state.headSha = ABC
 *   T1  Contributor pushes commit XYZ before context is built
 *   T2  GET /pulls/N returns live head XYZ
 *   Without pinning: /pulls/N/files would load XYZ's diff while checkout still uses ABC.
 *   With pinning: compare base...ABC loads ABC's diff; metadata shows head_sha: ABC.
 *
 * Out of scope for these unit tests:
 *   - Two overlapping synchronize deliveries (separate webhooks)
 *   - Head moving after context is built but before the turn completes
 *   - Title/body from GET /pulls/N while SHAs stay pinned
 */
describe("SHA pinning", () => {
  it("keeps webhook ABC when live PR head is XYZ at context build time", async () => {
    const webhookHead = "abc111fromwebhook";
    const webhookBase = "base999fromwebhook";
    const liveHead = "xyz999alreadyongithub";
    const liveFilesPatch = "@@ patch for the current PR head";

    const fetchMock = vi.fn((input: Request | URL | string) => {
      const url = String(input);
      if (url.includes("/files")) {
        return Promise.reject(new Error("did not expect /pulls/N/files when headSha is pinned"));
      }
      if (url.includes("/compare/")) {
        return Promise.resolve(
          jsonResponse({
            files: [
              {
                additions: 1,
                deletions: 0,
                filename: "packages/eve/src/at-abc.ts",
                patch: "@@ diff for abc111",
                status: "added",
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse(
          pullRequest({
            base: { ref: "main", repo: { full_name: "vercel/eve" }, sha: "other-live-base" },
            head: { ref: "feature/github", repo: { full_name: "octocat/eve" }, sha: liveHead },
          }),
        ),
      );
    });

    const messages = await buildGitHubPullRequestContext({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      baseSha: webhookBase,
      credentials,
      headSha: webhookHead,
      installationId: 55,
      owner: "vercel",
      pullRequestNumber: 7,
      repo: "eve",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://github.test/repos/vercel/eve/pulls/7");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      `https://github.test/repos/vercel/eve/compare/${webhookBase}...${webhookHead}`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text(messages)).toContain(`head_sha: ${webhookHead}`);
    expect(text(messages)).toContain(`base_sha: ${webhookBase}`);
    expect(text(messages)).not.toContain(liveHead);
    expect(text(messages)).toContain("- packages/eve/src/at-abc.ts");
    expect(text(messages)).toContain("@@ diff for abc111");
    expect(text(messages)).not.toContain(liveFilesPatch);
  });
});

describe("GitHub pull-request context", () => {
  it("builds metadata and the changed-file diff by default", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pullRequest()))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            additions: 4,
            deletions: 1,
            filename: "packages/eve/src/github.ts",
            patch: "@@ real patch",
            status: "modified",
          },
        ]),
      );

    const messages = await build(fetchMock);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://github.test/repos/vercel/eve/pulls/7");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://github.test/repos/vercel/eve/pulls/7/files?per_page=50",
    );
    expect(text(messages)).toContain("title: Add GitHub context");
    expect(text(messages)).toContain("head_sha: head-sha");
    expect(text(messages)).toContain("<github_pull_request_files>");
    expect(text(messages)).toContain("- packages/eve/src/github.ts (modified, +4, -1)");
    expect(text(messages)).toContain("@@ real patch");
  });

  it("lists built-in excluded lock files but omits their patch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pullRequest()))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            additions: 900,
            deletions: 12,
            filename: "pnpm-lock.yaml",
            patch: "MASSIVE LOCK DIFF",
            status: "modified",
          },
        ]),
      );

    const messages = await build(fetchMock);

    expect(text(messages)).toContain("- pnpm-lock.yaml (modified, +900, -12)");
    expect(text(messages)).toContain("patch omitted (excluded)");
    expect(text(messages)).not.toContain("MASSIVE LOCK DIFF");
  });

  it("extends the exclusion list with config.excludedFiles", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pullRequest()))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            filename: "src/api.generated.ts",
            patch: "GENERATED OUTPUT",
            status: "modified",
          },
        ]),
      );

    const messages = await build(fetchMock, { excludedFiles: ["**/*.generated.ts"] });

    expect(text(messages)).toContain("- src/api.generated.ts");
    expect(text(messages)).toContain("patch omitted (excluded)");
    expect(text(messages)).not.toContain("GENERATED OUTPUT");
  });

  it("truncates patch context past the byte budget", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(pullRequest()))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            filename: "src/a.ts",
            patch: "x".repeat(25_000),
            status: "modified",
          },
        ]),
      );

    const messages = await build(fetchMock);

    expect(text(messages)).toContain("[truncated]");
    expect(text(messages)).toContain("patches_truncated: true");
    expect(text(messages)).toContain("max_patch_bytes: 20000");
  });

  it("returns undefined when there is no pull request", async () => {
    const fetchMock = vi.fn();

    const messages = await buildGitHubPullRequestContext({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      credentials,
      installationId: 55,
      owner: "vercel",
      pullRequestNumber: null,
      repo: "eve",
    });

    expect(messages).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
