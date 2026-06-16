import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  GitHubApiError,
  callGitHubApi,
  createGitHubIssueComment,
  createGitHubPullRequestReviewComment,
  createGitHubReaction,
  createGitHubReviewCommentReply,
  getGitHubPullRequest,
  listGitHubPullRequestFiles,
  updateGitHubPullRequestReviewComment,
} from "#public/channels/github/api.js";
import {
  clearGitHubInstallationTokenCache,
  seedGitHubInstallationTokenForTests,
} from "#public/channels/github/auth.js";

const credentials = {
  appId: "test-app",
};

beforeEach(() => {
  clearGitHubInstallationTokenCache();
  seedGitHubInstallationTokenForTests({
    apiBaseUrl: "https://github.test",
    installationId: 123,
    token: "ghs_test",
  });
});

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("GitHub API helpers", () => {
  it("creates issue comments with installation-token auth and API overrides", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ html_url: "https://html", id: 10 }));

    const posted = await createGitHubIssueComment({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      body: "hello",
      credentials,
      installationId: 123,
      issueNumber: 5,
      owner: "vercel",
      repo: "eve",
    });

    expect(posted.id).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://github.test/repos/vercel/eve/issues/5/comments");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ghs_test");
    expect(requestBody(init)).toEqual({ body: "hello" });
  });

  it("routes review-thread replies through the pull request comments API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 11 }));

    await createGitHubReviewCommentReply({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      body: { body: "inline reply" },
      commentId: 99,
      credentials,
      installationId: 123,
      owner: "vercel",
      pullRequestNumber: 7,
      repo: "eve",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://github.test/repos/vercel/eve/pulls/7/comments/99/replies",
    );
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toEqual({ body: "inline reply" });
  });

  it("creates inline pull request review comments through the pull comments API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 12 }));

    await createGitHubPullRequestReviewComment({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      body: {
        body: "inline comment",
        commit_id: "abc123",
        line: 10,
        path: "src/file.ts",
      },
      credentials,
      installationId: 123,
      owner: "vercel",
      pullRequestNumber: 7,
      repo: "eve",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://github.test/repos/vercel/eve/pulls/7/comments",
    );
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toMatchObject({
      body: "inline comment",
      path: "src/file.ts",
    });
  });

  it("updates review-thread comments through the pull request comments API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: 11 }));

    await updateGitHubPullRequestReviewComment({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      body: "updated inline reply",
      commentId: 99,
      credentials,
      installationId: 123,
      owner: "vercel",
      repo: "eve",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://github.test/repos/vercel/eve/pulls/comments/99",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(requestBody(fetchMock.mock.calls[0]?.[1])).toEqual({ body: "updated inline reply" });
  });

  it("creates reactions on issue comments and throws owned API errors for non-2xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 12 }))
      .mockResolvedValueOnce(jsonResponse({ message: "bad credentials" }, { status: 401 }));

    await createGitHubReaction({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      commentId: 44,
      content: "eyes",
      credentials,
      installationId: 123,
      owner: "vercel",
      repo: "eve",
      subject: "issue_comment",
    });
    await expect(
      callGitHubApi({
        api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
        credentials,
        installationId: 123,
        method: "GET",
        path: "/repos/vercel/eve",
      }),
    ).rejects.toBeInstanceOf(GitHubApiError);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://github.test/repos/vercel/eve/issues/comments/44/reactions",
    );
  });

  it("fetches pull request metadata and bounded file lists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          base: {
            ref: "main",
            repo: { default_branch: "main", full_name: "vercel/eve" },
            sha: "base-sha",
          },
          changed_files: 1,
          draft: true,
          head: {
            ref: "feature",
            repo: { full_name: "octocat/eve" },
            sha: "head-sha",
          },
          number: 7,
          title: "Add feature",
          user: { id: 42, login: "octocat", type: "User" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            additions: 2,
            deletions: 1,
            filename: "src/file.ts",
            patch: "@@ patch",
            status: "modified",
          },
        ]),
      );

    const details = await getGitHubPullRequest({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      credentials,
      installationId: 123,
      owner: "vercel",
      pullRequestNumber: 7,
      repo: "eve",
    });
    const files = await listGitHubPullRequestFiles({
      api: { apiBaseUrl: "https://github.test", fetch: fetchMock },
      credentials,
      installationId: 123,
      owner: "vercel",
      perPage: 5,
      pullRequestNumber: 7,
      repo: "eve",
    });

    expect(details).toMatchObject({
      author: { login: "octocat" },
      base: { ref: "main", sha: "base-sha" },
      defaultBranch: "main",
      draft: true,
      head: { ref: "feature", sha: "head-sha" },
      number: 7,
      title: "Add feature",
    });
    expect(files).toEqual([
      {
        additions: 2,
        changes: undefined,
        deletions: 1,
        filename: "src/file.ts",
        patch: "@@ patch",
        status: "modified",
      },
    ]);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://github.test/repos/vercel/eve/pulls/7/files?per_page=5",
    );
  });
});
