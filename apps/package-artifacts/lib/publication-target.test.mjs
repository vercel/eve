import { describe, expect, test, vi } from "vitest";

import { resolvePublicationTarget } from "./publication-target.mjs";

const sha = "a".repeat(40);
const repo = { owner: "vercel", repo: "eve" };

function workflowRun(overrides = {}) {
  return {
    id: 123,
    conclusion: "success",
    event: "pull_request",
    head_branch: "feature/package",
    head_repository: { full_name: "vercel/eve" },
    head_sha: sha,
    ...overrides,
  };
}

function pull(overrides = {}) {
  return {
    number: 456,
    state: "open",
    base: { ref: "main" },
    head: {
      ref: "feature/package",
      repo: { full_name: "vercel/eve" },
      sha,
    },
    ...overrides,
  };
}

function context(run) {
  return { repo, payload: { workflow_run: run } };
}

function github({ branchSha = sha, pulls = [] } = {}) {
  const listPullRequests = vi.fn();
  return {
    paginate: vi.fn().mockResolvedValue(pulls),
    rest: {
      pulls: { list: listPullRequests },
      repos: {
        getBranch: vi.fn().mockResolvedValue({ data: { commit: { sha: branchSha } } }),
      },
    },
  };
}

describe("package publication target", () => {
  test("publishes the current main build", async () => {
    const api = github();
    await expect(
      resolvePublicationTarget(api, context(workflowRun({ event: "push", head_branch: "main" }))),
    ).resolves.toEqual({ runId: "123", sha, ref: "main" });
    expect(api.rest.repos.getBranch).toHaveBeenCalledWith({ ...repo, branch: "main" });
  });

  test("rejects stale main builds", async () => {
    const api = github({ branchSha: "b".repeat(40) });
    await expect(
      resolvePublicationTarget(api, context(workflowRun({ event: "push", head_branch: "main" }))),
    ).rejects.toThrow("Refusing to publish stale main build");
  });

  test("publishes the current pull request build", async () => {
    const api = github({ pulls: [pull()] });
    await expect(resolvePublicationTarget(api, context(workflowRun()))).resolves.toEqual({
      runId: "123",
      sha,
      ref: "456",
    });
    expect(api.paginate).toHaveBeenCalledWith(api.rest.pulls.list, {
      ...repo,
      base: "main",
      head: "vercel:feature/package",
      state: "open",
      per_page: 100,
    });
  });

  test("rejects pull requests from forks", async () => {
    const run = workflowRun({ head_repository: { full_name: "alice/eve" } });
    const api = github();
    await expect(resolvePublicationTarget(api, context(run))).rejects.toThrow(
      "Refusing to publish package artifacts from alice/eve",
    );
    expect(api.paginate).not.toHaveBeenCalled();
  });

  test("rejects stale, closed, mismatched, and ambiguous pull requests", async () => {
    const stale = pull({
      head: { ref: "feature/package", repo: { full_name: "vercel/eve" }, sha: "b".repeat(40) },
    });
    const closed = pull({ state: "closed" });
    const wrongBase = pull({ base: { ref: "release" } });
    const wrongRepository = pull({
      head: { ref: "feature/package", repo: { full_name: "alice/eve" }, sha },
    });

    for (const pulls of [
      [stale],
      [closed],
      [wrongBase],
      [wrongRepository],
      [pull(), pull({ number: 789 })],
    ]) {
      await expect(
        resolvePublicationTarget(github({ pulls }), context(workflowRun())),
      ).rejects.toThrow("Expected one open pull request");
    }
  });

  test("rejects failed and unsupported builds", async () => {
    await expect(
      resolvePublicationTarget(github(), context(workflowRun({ conclusion: "failure" }))),
    ).rejects.toThrow("requires a successful package build");
    await expect(
      resolvePublicationTarget(github(), context(workflowRun({ event: "workflow_dispatch" }))),
    ).rejects.toThrow("Unsupported package build event");
  });
});
