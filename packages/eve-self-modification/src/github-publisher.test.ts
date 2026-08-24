import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SelfModificationCommandSandbox } from "./git-workspace.js";
import { publishSelfModificationProposal, selfModificationBranchName } from "./github-publisher.js";

const DEPLOYED_SHA = "1".repeat(40);
const BASE_SHA = "2".repeat(40);
const PROPOSED_TREE_SHA = "3".repeat(40);
const BASE_TREE_SHA = "4".repeat(40);
const GITHUB_BLOB_SHA = "7".repeat(40);
const GITHUB_COMMIT_SHA = "9".repeat(40);
const OPERATION_ID = "session/root-turn/subagent-call";
const BRANCH = selfModificationBranchName(DEPLOYED_SHA, OPERATION_ID);
const REPOSITORY = { owner: "acme", pullRequestBase: "main", repo: "agent" };
const CONTENT = "hello";

interface RecordedRequest {
  readonly body: unknown;
  readonly headers: Headers;
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly signal: unknown;
}

type ResponseOverride = (init?: RequestInit) => Response;

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function rawDiff(entries: readonly string[]): string {
  return `${entries.join("\0")}\0`;
}

const MODIFIED_DIFF = rawDiff([
  `:100644 100644 ${"a".repeat(40)} ${gitBlobSha(CONTENT)} M`,
  "agent/instructions.md",
]);
const DELETED_DIFF = rawDiff([
  `:100644 000000 ${"a".repeat(40)} ${"0".repeat(40)} D`,
  "agent/removed.md",
]);

function createSandbox(raw = MODIFIED_DIFF) {
  const commands: string[] = [];
  const sandbox: SelfModificationCommandSandbox = {
    async run({ command }: { command: string }) {
      commands.push(command);
      if (command.endsWith("write-tree")) return success(PROPOSED_TREE_SHA);
      if (command.includes("^{tree}")) return success(BASE_TREE_SHA);
      if (command.includes("diff-tree")) return success(raw);
      if (command.includes("cat-file -s")) return success(String(Buffer.byteLength(CONTENT)));
      if (command.includes("cat-file blob"))
        return success(Buffer.from(CONTENT).toString("base64"));
      return success();
    },
  };
  return { commands, sandbox };
}

function success(stdout = "") {
  return { exitCode: 0, stderr: "", stdout };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function pullRequest(number: number, overrides: Record<string, unknown> = {}) {
  return {
    base: { ref: "main" },
    draft: true,
    head: { ref: BRANCH },
    html_url: `https://github.com/acme/agent/pull/${number}`,
    number,
    state: "open",
    ...overrides,
  };
}

/** Records every request and answers it, letting `overrides` replace a path suffix. */
function githubFetch(
  answer: (path: string, init?: RequestInit) => Response,
  overrides: Record<string, ResponseOverride>,
) {
  const requests: RecordedRequest[] = [];
  const apiFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(String(url));
    requests.push({
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      headers: new Headers(init?.headers),
      method: String(init?.method),
      path: parsed.pathname,
      search: parsed.search,
      signal: init?.signal,
    });
    for (const [suffix, respond] of Object.entries(overrides)) {
      if (parsed.pathname.endsWith(suffix)) return respond(init);
    }
    return answer(parsed.pathname, init);
  }) as typeof fetch;
  return { apiFetch, requests };
}

/** Answers the path that creates a branch and pull request for the first time. */
function createFlowFetch(overrides: Record<string, ResponseOverride> = {}) {
  return githubFetch((path) => {
    if (path.endsWith(`/git/ref/heads/${BRANCH}`)) return json({}, 404);
    if (path.endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: BASE_SHA }, ref: "refs/heads/main" });
    }
    if (path.endsWith("/git/blobs")) return json({ sha: GITHUB_BLOB_SHA }, 201);
    if (path.endsWith("/git/trees")) return json({ sha: PROPOSED_TREE_SHA }, 201);
    if (path.endsWith("/git/commits")) return json({ sha: GITHUB_COMMIT_SHA }, 201);
    if (path.endsWith("/git/refs")) return json({}, 201);
    if (path.endsWith("/pulls")) return json(pullRequest(7), 201);
    throw new Error(`Unexpected request: ${path}`);
  }, overrides);
}

/** Answers a replay against a branch this operation already published. */
function replayFlowFetch(overrides: Record<string, ResponseOverride> = {}) {
  return githubFetch((path) => {
    if (path.endsWith(`/git/ref/heads/${BRANCH}`)) {
      return json({ object: { sha: GITHUB_COMMIT_SHA }, ref: `refs/heads/${BRANCH}` });
    }
    if (path.endsWith(`/git/commits/${GITHUB_COMMIT_SHA}`)) {
      return json({
        parents: [{ sha: BASE_SHA }],
        sha: GITHUB_COMMIT_SHA,
        tree: { sha: PROPOSED_TREE_SHA },
      });
    }
    if (path.endsWith("/pulls")) return json([pullRequest(7)]);
    throw new Error(`Unexpected request: ${path}`);
  }, overrides);
}

function publicationInput(sandbox: SelfModificationCommandSandbox, apiFetch: typeof fetch) {
  return {
    body: "Generated from a deployed request.",
    personalAccessToken: () => "github-token",
    deployedSha: DEPLOYED_SHA,
    fetch: apiFetch,
    operationId: OPERATION_ID,
    repository: REPOSITORY,
    sandbox,
    title: "Update agent instructions",
    workspace: {
      baseSha: BASE_SHA,
      deployedPath: "/workspace/self-modification/deployed",
      deployedSha: DEPLOYED_SHA,
      repositoryPath: "/workspace/self-modification/repository",
      rootDirectory: ".",
    },
  };
}

async function publicationError(
  sandbox: SelfModificationCommandSandbox,
  apiFetch: typeof fetch,
): Promise<Error> {
  return await publishSelfModificationProposal(publicationInput(sandbox, apiFetch)).then(
    () => {
      throw new Error("Expected publication to fail.");
    },
    (thrown: unknown) => thrown as Error,
  );
}

describe("publishSelfModificationProposal", () => {
  it("rejects a workspace from another deployed revision", async () => {
    const { sandbox } = createSandbox();
    const input = publicationInput(sandbox, vi.fn() as typeof fetch);

    await expect(
      publishSelfModificationProposal({
        ...input,
        workspace: { ...input.workspace, deployedSha: "f".repeat(40) },
      }),
    ).rejects.toThrow(/does not match the deployed revision/u);
  });

  it("rejects a title that spans more than one line", async () => {
    const { sandbox } = createSandbox();
    const input = publicationInput(sandbox, vi.fn() as typeof fetch);

    await expect(
      publishSelfModificationProposal({ ...input, title: "Update instructions\nand tools" }),
    ).rejects.toThrow(/single line/u);
  });

  it("uploads validated blobs and creates one namespaced draft pull request", async () => {
    const { commands, sandbox } = createSandbox();
    const { apiFetch, requests } = createFlowFetch();

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).resolves.toEqual({
      base: "main",
      branch: BRANCH,
      changedPaths: ["agent/instructions.md"],
      commitSha: GITHUB_COMMIT_SHA,
      deployedSha: DEPLOYED_SHA,
      draft: true,
      pullRequestState: "open",
      pullRequestUrl: "https://github.com/acme/agent/pull/7",
    });

    expect(commands.join("\n")).not.toContain("github-token");
    expect(requests.find((request) => request.path.endsWith("/git/blobs"))?.body).toEqual({
      content: Buffer.from(CONTENT).toString("base64"),
      encoding: "base64",
    });
    expect(requests.find((request) => request.path.endsWith("/git/trees"))?.body).toEqual({
      base_tree: BASE_TREE_SHA,
      tree: [{ mode: "100644", path: "agent/instructions.md", sha: GITHUB_BLOB_SHA, type: "blob" }],
    });
    const commitBody = requests.find((request) => request.path.endsWith("/git/commits"))?.body;
    expect(commitBody).toMatchObject({ parents: [BASE_SHA], tree: PROPOSED_TREE_SHA });
    expect(commitBody).not.toHaveProperty("author");
    expect(commitBody).not.toHaveProperty("committer");
    expect(requests.find((request) => request.path.endsWith("/pulls"))?.body).toMatchObject({
      base: "main",
      draft: true,
      head: BRANCH,
    });
  });

  it("rejects policy-excluded changes before resolving credentials or calling GitHub", async () => {
    const { sandbox } = createSandbox(
      rawDiff([
        `:100644 100644 ${"a".repeat(40)} ${gitBlobSha(CONTENT)} M`,
        "agent/instructions.md",
        `:100644 100644 ${"b".repeat(40)} ${gitBlobSha(CONTENT)} M`,
        "package.json",
      ]),
    );
    const personalAccessToken = vi.fn(() => "github-token");
    const apiFetch = vi.fn() as typeof fetch;

    await expect(
      publishSelfModificationProposal({
        ...publicationInput(sandbox, apiFetch),
        personalAccessToken,
      }),
    ).rejects.toThrow(/policy-excluded changes: .*package\.json/u);

    expect(personalAccessToken).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("looks up refs with unencoded path separators", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch, requests } = createFlowFetch();

    await publishSelfModificationProposal(publicationInput(sandbox, apiFetch));

    const refPaths = requests
      .map((request) => request.path)
      .filter((path) => path.includes("/git/ref/"));
    expect(refPaths).toEqual([
      `/repos/acme/agent/git/ref/heads/${BRANCH}`,
      "/repos/acme/agent/git/ref/heads/main",
    ]);
  });

  it("sends a mode and blob type for a deleted path", async () => {
    const { sandbox } = createSandbox(DELETED_DIFF);
    const { apiFetch, requests } = createFlowFetch();

    await publishSelfModificationProposal(publicationInput(sandbox, apiFetch));

    expect(requests.find((request) => request.path.endsWith("/git/trees"))?.body).toEqual({
      base_tree: BASE_TREE_SHA,
      tree: [{ mode: "100644", path: "agent/removed.md", sha: null, type: "blob" }],
    });
    expect(requests.some((request) => request.path.endsWith("/git/blobs"))).toBe(false);
  });

  it("fails closed when GitHub reassembles a different tree", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({
      "/git/trees": () => json({ sha: "b".repeat(40) }, 201),
    });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/did not reassemble into the validated Git tree/u);
  });

  it("fails closed when a sandbox blob does not match its captured object id", async () => {
    const { sandbox } = createSandbox(
      rawDiff([`:100644 100644 ${"a".repeat(40)} ${"c".repeat(40)} M`, "agent/instructions.md"]),
    );
    const { apiFetch } = createFlowFetch();

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/changed after validation/u);
  });

  it("fails closed when GitHub opens the pull request ready for review", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({
      "/pulls": () => json(pullRequest(7, { draft: false }), 201),
    });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/did not open the self-modification pull request as a draft/u);
  });

  it("fails closed when GitHub returns a pull request for another branch", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({
      "/pulls": () => json(pullRequest(7, { head: { ref: "main" } }), 201),
    });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/invalid self-modification pull request/u);
  });

  it("reuses an existing branch and pull request without rewriting Git objects", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch, requests } = replayFlowFetch();

    const result = await publishSelfModificationProposal(publicationInput(sandbox, apiFetch));

    expect(result.commitSha).toBe(GITHUB_COMMIT_SHA);
    expect(result.pullRequestUrl).toBe("https://github.com/acme/agent/pull/7");
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "GET"]);
    expect(requests.at(-1)?.search).toContain("state=all");
  });

  it("reports a replayed pull request that a reviewer already closed", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = replayFlowFetch({
      "/pulls": () => json([pullRequest(7, { draft: false, state: "closed" })]),
    });

    const result = await publishSelfModificationProposal(publicationInput(sandbox, apiFetch));

    expect(result).toMatchObject({ draft: false, pullRequestState: "closed" });
  });

  it("opens a draft pull request for an existing operation branch", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch, requests } = replayFlowFetch({
      "/pulls": (init) => (init?.method === "POST" ? json(pullRequest(8), 201) : json([])),
    });

    const result = await publishSelfModificationProposal(publicationInput(sandbox, apiFetch));

    expect(result.pullRequestUrl).toBe("https://github.com/acme/agent/pull/8");
    expect(requests.some((request) => request.path.endsWith("/git/blobs"))).toBe(false);
  });

  it("rejects replay when the existing operation branch has a different tree", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = replayFlowFetch({
      [`/git/commits/${GITHUB_COMMIT_SHA}`]: () =>
        json({
          parents: [{ sha: BASE_SHA }],
          sha: GITHUB_COMMIT_SHA,
          tree: { sha: "a".repeat(40) },
        }),
    });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/already published a different proposal/u);
  });

  it("rejects replay when the existing branch targets another base revision", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = replayFlowFetch({
      [`/git/commits/${GITHUB_COMMIT_SHA}`]: () =>
        json({
          parents: [{ sha: "e".repeat(40) }],
          sha: GITHUB_COMMIT_SHA,
          tree: { sha: PROPOSED_TREE_SHA },
        }),
    });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/different pull request base revision/u);
  });

  it("treats an ambiguous ref match as an absent branch", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({
      [`/git/ref/heads/${BRANCH}`]: () =>
        json([{ object: { sha: GITHUB_COMMIT_SHA }, ref: `refs/heads/${BRANCH}-other` }]),
    });

    const result = await publishSelfModificationProposal(publicationInput(sandbox, apiFetch));

    expect(result.commitSha).toBe(GITHUB_COMMIT_SHA);
  });

  it("distinguishes a missing pull request base from one that moved", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({ "/git/ref/heads/main": () => json({}, 404) });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/base "main" does not exist in acme\/agent/u);
  });

  it("fails closed when the configured base moves", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({
      "/git/ref/heads/main": () =>
        json({ object: { sha: "f".repeat(40) }, ref: "refs/heads/main" }),
    });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/base moved/u);
  });

  it("surfaces the GitHub failure explanation without the access token", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({
      "/git/blobs": () =>
        json(
          {
            errors: [{ code: "missing", field: "contents", resource: "Blob" }],
            message: "Resource not accessible by personal access token",
          },
          403,
          { "retry-after": "60" },
        ),
    });

    const error = await publicationError(sandbox, apiFetch);

    expect(error.message).toContain("HTTP 403");
    expect(error.message).toContain("Resource not accessible by personal access token");
    expect(error.message).toContain("Blob.contents.missing");
    expect(error.message).toContain("retry after 60s");
    expect(error.message).not.toContain("github-token");
  });

  it("identifies itself and bounds every GitHub request", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch, requests } = createFlowFetch();

    await publishSelfModificationProposal(publicationInput(sandbox, apiFetch));

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.headers.get("user-agent")).toBe("eve-self-modification");
      expect(request.headers.get("authorization")).toBe("Bearer github-token");
      expect(request.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("rejects a malformed GitHub response instead of dereferencing it", async () => {
    const { sandbox } = createSandbox();
    const { apiFetch } = createFlowFetch({
      "/git/ref/heads/main": () => json({ ref: "refs/heads/main" }),
    });

    await expect(
      publishSelfModificationProposal(publicationInput(sandbox, apiFetch)),
    ).rejects.toThrow(/unexpected ref response/u);
  });
});
