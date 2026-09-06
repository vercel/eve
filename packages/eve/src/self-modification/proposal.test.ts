import { describe, expect, it } from "vitest";

import { publishGitHubDraftPullRequest, selfModificationBranchName } from "./github-publisher.js";
import { assertAllowedChange, parseRawDiff } from "./proposal.js";

describe("self-modification proposal capture", () => {
  it("parses only complete, safe raw Git diff records", () => {
    expect(
      parseRawDiff(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0agent/instructions.md\0`),
    ).toEqual([
      {
        newMode: "100644",
        newObjectId: "b".repeat(40),
        path: "agent/instructions.md",
        status: "M",
      },
    ]);
    expect(() =>
      parseRawDiff(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0../.env\0`),
    ).toThrow("malformed");
  });

  it("allows repository changes but protects publication controls and privileged paths", () => {
    expect(() =>
      assertAllowedChange({ mode: "100644", objectId: blob, path: "package.json" }, "."),
    ).not.toThrow();
    for (const path of [
      ".github/workflows/deploy.yml",
      ".env.production",
      ".envrc",
      ".turbo/cache/state.json",
      "node_modules/eve/index.js",
      "agent/subagents/self-modification/agent.ts",
      "agent/extensions/selfmod.ts",
    ]) {
      expect(() => assertAllowedChange({ mode: "100644", objectId: blob, path }, ".")).toThrow(
        "protected path",
      );
    }
  });

  it("derives a stable namespaced branch from trusted base and operation identifiers", () => {
    const branch = selfModificationBranchName("a".repeat(40), "parent-session:child-session");
    expect(branch).toMatch(/^eve-self-modification\/aaaaaaaaaaaa\/[a-f0-9]{24}$/u);
    expect(branch).toBe(selfModificationBranchName("a".repeat(40), "parent-session:child-session"));
    expect(() => selfModificationBranchName("a".repeat(40), "")).toThrow("operation id");
  });

  it("reports every changed path without registry provenance", async () => {
    const bodies: unknown[] = [];
    const result = await publish(successfulFetch(bodies));

    expect(result.changedPaths).toEqual(["agent/instructions.md"]);
    expect(JSON.stringify(bodies)).not.toContain("Registry items");
  });

  it("does not report a closed draft as a published proposal on retry", async () => {
    await expect(publish(closedDraftFetch())).rejects.toThrow("invalid pull request");
  });

  it("rechecks the target branch before creating the pull request", async () => {
    const calls: string[] = [];
    await expect(publish(targetMovesBeforePullRequestFetch(calls))).rejects.toThrow(
      "target branch changed",
    );
    expect(calls.filter((path) => path.endsWith("/git/ref/heads/main"))).toHaveLength(2);
    expect(calls).not.toContain("/repos/acme/agent/pulls");
  });

  it("rechecks the target branch before recovering a missing pull request", async () => {
    const calls: string[] = [];
    await expect(publish(targetMovesDuringReplayFetch(calls))).rejects.toThrow(
      "target branch changed",
    );
    expect(calls.filter((path) => path.endsWith("/git/ref/heads/main"))).toHaveLength(2);
    expect(calls.filter((path) => path === "/repos/acme/agent/pulls")).toHaveLength(1);
  });
});

const base = "a".repeat(40);
const baseTree = "b".repeat(40);
const proposedTree = "c".repeat(40);
const blob = "c1b0730e0133447badcfd47fd144e254807b06e1";

function publish(fetch: typeof globalThis.fetch) {
  return publishGitHubDraftPullRequest({
    credentialProvider: { resolve: async () => "token" },
    description: "Change the instructions.",
    fetch,
    operationId: "parent:child",
    sandbox: {
      run: async ({ command }) => {
        if (command.includes(" add -A")) return result("");
        if (command.includes("write-tree")) return result(proposedTree);
        if (command.includes("^{tree}")) return result(baseTree);
        if (command.includes("diff-tree"))
          return result(`:100644 100644 ${base} ${blob} M\0agent/instructions.md\0`);
        if (command.includes("cat-file -s")) return result("1");
        if (command.includes("cat-file blob")) return result("eA==");
        throw new Error(`Unexpected Git command: ${command}`);
      },
    },
    title: "Update instructions",
    workspace: {
      baseSha: base,
      directory: ".",
      repository: { owner: "acme", repo: "agent" },
      repositoryPath: "/workspace/repository",
      targetBranch: "main",
    },
  });
}

function successfulFetch(bodies: unknown[]): typeof globalThis.fetch {
  return (async (url, init) => {
    const request = new URL(String(url));
    const path = request.pathname;
    if (init?.body !== undefined) bodies.push(JSON.parse(String(init.body)));
    if (path === "/repos/acme/agent/git/ref/heads/main") return response({ object: { sha: base } });
    if (path.includes("eve-self-modification")) return response({}, 404);
    if (path === "/repos/acme/agent/git/blobs") return response({ sha: blob });
    if (path === "/repos/acme/agent/git/trees") return response({ sha: proposedTree });
    if (path === "/repos/acme/agent/git/commits") return response({ sha: "d".repeat(40) });
    if (path === "/repos/acme/agent/git/refs") return response({});
    if (path === "/repos/acme/agent/pulls") {
      const body = JSON.parse(String(init?.body));
      return response({
        base: { ref: body.base },
        draft: true,
        head: { ref: body.head },
        html_url: "https://github.com/acme/agent/pull/1",
        state: "open",
      });
    }
    throw new Error(`Unexpected GitHub request: ${path}`);
  }) as typeof globalThis.fetch;
}

function closedDraftFetch(): typeof globalThis.fetch {
  return (async (url) => {
    const request = new URL(String(url));
    const path = request.pathname;
    if (path === "/repos/acme/agent/git/ref/heads/main") return response({ object: { sha: base } });
    if (path.includes("eve-self-modification"))
      return response({ object: { sha: "d".repeat(40) } });
    if (path === `/repos/acme/agent/git/commits/${"d".repeat(40)}`)
      return response({ parents: [{ sha: base }], tree: { sha: proposedTree } });
    if (path === "/repos/acme/agent/pulls")
      return response([
        {
          base: { ref: "main" },
          draft: true,
          head: { ref: request.searchParams.get("head")!.split(":")[1] },
          html_url: "https://github.com/acme/agent/pull/1",
          state: "closed",
        },
      ]);
    throw new Error(`Unexpected GitHub request: ${path}`);
  }) as typeof globalThis.fetch;
}

function targetMovesBeforePullRequestFetch(calls: string[]): typeof globalThis.fetch {
  let targetReads = 0;
  return (async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/repos/acme/agent/git/ref/heads/main") {
      targetReads += 1;
      return response({ object: { sha: targetReads === 1 ? base : "e".repeat(40) } });
    }
    if (path.includes("eve-self-modification")) return response({}, 404);
    if (path === "/repos/acme/agent/git/blobs") return response({ sha: blob });
    if (path === "/repos/acme/agent/git/trees") return response({ sha: proposedTree });
    if (path === "/repos/acme/agent/git/commits") return response({ sha: "d".repeat(40) });
    if (path === "/repos/acme/agent/git/refs") return response({});
    throw new Error(`Unexpected GitHub request: ${path}`);
  }) as typeof globalThis.fetch;
}

function targetMovesDuringReplayFetch(calls: string[]): typeof globalThis.fetch {
  let targetReads = 0;
  return (async (url) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path === "/repos/acme/agent/git/ref/heads/main") {
      targetReads += 1;
      return response({ object: { sha: targetReads === 1 ? base : "e".repeat(40) } });
    }
    if (path.includes("eve-self-modification"))
      return response({ object: { sha: "d".repeat(40) } });
    if (path === `/repos/acme/agent/git/commits/${"d".repeat(40)}`)
      return response({ parents: [{ sha: base }], tree: { sha: proposedTree } });
    if (path === "/repos/acme/agent/pulls") return response([]);
    throw new Error(`Unexpected GitHub request: ${path}`);
  }) as typeof globalThis.fetch;
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}
function result(stdout: string) {
  return { exitCode: 0, stderr: "", stdout };
}
