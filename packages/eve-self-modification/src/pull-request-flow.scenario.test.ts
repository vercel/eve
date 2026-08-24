import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { RuntimeSandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";
import { afterEach, describe, expect, it, vi } from "vitest";

const exec = promisify(execCallback);
const execFile = promisify(execFileCallback);
const deployedSha = vi.hoisted(() => ({ value: "" }));

vi.mock("eve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("eve")>()),
  getDeploymentSource: () => ({
    repository: "github.com/acme/agent",
    revision: deployedSha.value,
    rootDirectory: ".",
  }),
}));

import { defineSelfModificationPublishTool } from "../extension/tools/publish.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("deployed self-modification publication", () => {
  it("validates a real Git workspace and reconciles publication through a fake GitHub API", async () => {
    const repositoryPath = await createRepository();
    const commands: string[] = [];
    const sandbox = localSandbox(repositoryPath, commands);

    const scratch = await mkdtemp(join(tmpdir(), "eve-self-modification-github-"));
    temporaryDirectories.push(scratch);
    const requests: Array<{ method: string; path: string }> = [];
    let branch: string | null = null;
    let branchSha: string | null = null;
    let pullRequestCreated = false;
    let treeCount = 0;
    let blobCount = 0;

    // The fake answers from the real repository, so every object id GitHub would compute
    // is computed by Git here too. A publisher that assembled the wrong tree entries or
    // encoded a ref path GitHub cannot route fails this test instead of a hand-written mock.
    const githubFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      const method = init?.method ?? "GET";
      const path = parsed.pathname;
      requests.push({ method, path: path.replace("/repos/acme/agent", "") });

      const refMatch = /\/git\/ref\/(heads\/eve-self-modification\/.+)$/u.exec(path);
      if (refMatch !== null) {
        return branchSha === null
          ? response({}, 404)
          : response({ object: { sha: branchSha }, ref: `refs/${refMatch[1]!}` });
      }
      if (path.endsWith("/git/ref/heads/main")) {
        const baseSha = await git(repositoryPath, ["rev-parse", "refs/eve-self-modification/base"]);
        return response({ object: { sha: baseSha }, ref: "refs/heads/main" });
      }
      const commitMatch = /\/git\/commits\/([a-f0-9]{40})$/u.exec(path);
      if (commitMatch !== null && method === "GET") {
        const sha = commitMatch[1]!;
        const lineage = (
          await git(repositoryPath, ["rev-list", "--parents", "-n", "1", sha])
        ).split(" ");
        return response({
          parents: lineage.slice(1).map((parent) => ({ sha: parent })),
          sha,
          tree: { sha: await git(repositoryPath, ["rev-parse", `${sha}^{tree}`]) },
        });
      }
      if (path.endsWith("/git/blobs")) {
        const file = join(scratch, `blob-${(blobCount += 1)}`);
        await writeFile(file, Buffer.from(String(body.content), "base64"));
        return response({ sha: await git(repositoryPath, ["hash-object", "-w", "--", file]) }, 201);
      }
      if (path.endsWith("/git/trees")) {
        const sha = await assembleTree(
          repositoryPath,
          body,
          join(scratch, `index-${(treeCount += 1)}`),
        );
        return response({ sha }, 201);
      }
      if (path.endsWith("/git/commits")) {
        const sha = await git(repositoryPath, [
          "commit-tree",
          String(body.tree),
          "-p",
          String(body.parents[0]),
          "-m",
          String(body.message),
        ]);
        return response({ sha }, 201);
      }
      if (path.endsWith("/git/refs")) {
        branch = String(body.ref).replace("refs/heads/", "");
        branchSha = String(body.sha);
        return response({}, 201);
      }
      if (path.endsWith("/pulls") && method === "GET") {
        return response(pullRequestCreated ? [pullRequest(branch)] : []);
      }
      if (path.endsWith("/pulls") && method === "POST") {
        pullRequestCreated = true;
        return response(pullRequest(String(body.head)), 201);
      }
      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    });
    vi.stubGlobal("fetch", githubFetch);

    vi.stubEnv("EVE_SELF_MODIFICATION_GITHUB_TOKEN", "github-token");
    const publish = defineSelfModificationPublishTool({
      repository: { owner: "acme", targetBranch: "main", repo: "agent" },
    });
    const tool = await publish.events["session.started"]?.({}, {} as never);
    if (tool === null || tool === undefined || !("execute" in tool)) {
      throw new Error("Expected configured publish tool.");
    }

    const first = await tool.execute(
      { summary: "Update the agent instructions.", title: "Update agent instructions" },
      toolContext(sandbox),
    );
    const replay = await tool.execute(
      { summary: "Update the agent instructions.", title: "Update agent instructions" },
      toolContext(sandbox),
    );

    if (Symbol.asyncIterator in first || Symbol.asyncIterator in replay) {
      throw new Error("Expected non-streaming tool results.");
    }
    expect(first.pullRequestUrl).toBe("https://github.com/acme/agent/pull/12");
    expect(first).toMatchObject({ draft: true, pullRequestState: "open" });
    expect([...first.changedPaths].sort()).toEqual(["agent/base.md", "agent/instructions.md"]);
    expect(replay.pullRequestUrl).toBe(first.pullRequestUrl);
    expect(replay.commitSha).toBe(first.commitSha);
    expect(commands.join("\n")).not.toContain("github-token");

    // The published commit is a real object, so the proposal survived capture, blob
    // upload, and tree assembly byte for byte.
    expect(
      await git(repositoryPath, ["cat-file", "-p", `${first.commitSha}:agent/instructions.md`]),
    ).toBe("Updated instructions.");
    await expect(
      git(repositoryPath, ["cat-file", "-e", `${first.commitSha}:agent/base.md`]),
    ).rejects.toThrow();

    // The replay reconciles against captured object ids without writing anything.
    expect(requests.filter((request) => request.method === "POST").map((r) => r.path)).toEqual([
      "/git/blobs",
      "/git/trees",
      "/git/commits",
      "/git/refs",
      "/pulls",
    ]);
  });
});

async function createRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "eve-self-modification-pull-request-"));
  temporaryDirectories.push(path);
  await git(path, ["init", "--initial-branch=main"]);
  await git(path, ["config", "user.name", "Scenario"]);
  await git(path, ["config", "user.email", "scenario@example.com"]);
  await execFile("mkdir", ["-p", join(path, "agent")]);
  await writeFile(join(path, "agent/instructions.md"), "Original instructions.\n");
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "deployed"]);
  deployedSha.value = await git(path, ["rev-parse", "HEAD"]);
  await git(path, ["update-ref", "refs/eve-self-modification/deployed", deployedSha.value]);
  await writeFile(join(path, "agent/base.md"), "Base branch context.\n");
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "base"]);
  await git(path, ["update-ref", "refs/eve-self-modification/base", "HEAD"]);
  await writeFile(join(path, "agent/instructions.md"), "Updated instructions.\n");
  await rm(join(path, "agent/base.md"));
  return path;
}

function localSandbox(repositoryPath: string, commands: string[]): RuntimeSandboxSession {
  const unavailable = async (): Promise<never> => {
    throw new Error("Unsupported by scenario sandbox.");
  };
  return {
    id: "scenario-sandbox",
    readBinaryFile: unavailable,
    readFile: unavailable,
    readTextFile: unavailable,
    removePath: unavailable,
    resolvePath: (path) => path,
    async run({ abortSignal, command, workingDirectory }) {
      commands.push(command);
      const translated = command.replaceAll(
        "/workspace/self-modification/repository",
        repositoryPath,
      );
      const translatedWorkingDirectory = workingDirectory?.replaceAll(
        "/workspace/self-modification/repository",
        repositoryPath,
      );
      try {
        const result = await exec(translated, {
          cwd: translatedWorkingDirectory ?? tmpdir(),
          signal: abortSignal,
        });
        return { exitCode: 0, stderr: result.stderr, stdout: result.stdout };
      } catch (error) {
        const failure = error as { code?: number; stderr?: string; stdout?: string };
        return {
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stderr: failure.stderr ?? String(error),
          stdout: failure.stdout ?? "",
        };
      }
    },
    setNetworkPolicy: unavailable,
    spawn: unavailable,
    async stop() {},
    writeBinaryFile: unavailable,
    writeFile: unavailable,
    writeTextFile: unavailable,
  };
}

function toolContext(sandbox: RuntimeSandboxSession): ToolContext {
  return {
    abortSignal: new AbortController().signal,
    callId: "publish-call",
    getSandbox: async () => sandbox,
    getSkill() {
      throw new Error("No skills in scenario.");
    },
    async getToken() {
      throw new Error("No tool auth in scenario.");
    },
    requireAuth() {
      throw new Error("No tool auth in scenario.");
    },
    session: {
      auth: {
        current: {
          attributes: { role: "admin" },
          authenticator: "scenario",
          principalId: "admin-1",
          principalType: "user",
        },
        initiator: null,
      },
      id: "child-session",
      parent: {
        callId: "delegation-call",
        rootSessionId: "root-session",
        sessionId: "parent-session",
        turn: { id: "root-turn", sequence: 0 },
      },
      turn: { id: "child-turn", sequence: 0 },
    },
    toolName: "publish",
  };
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFile("git", args, { cwd });
  return result.stdout.trim();
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function pullRequest(head: string | null) {
  return {
    base: { ref: "main" },
    draft: true,
    head: { ref: head },
    html_url: "https://github.com/acme/agent/pull/12",
    number: 12,
    state: "open",
  };
}

/** Applies create-tree entries to `base_tree` exactly as GitHub does, using real Git. */
async function assembleTree(
  repositoryPath: string,
  body: {
    readonly base_tree: string;
    readonly tree: readonly { mode: string; path: string; sha: string | null }[];
  },
  indexFile: string,
): Promise<string> {
  const options = { cwd: repositoryPath, env: { ...process.env, GIT_INDEX_FILE: indexFile } };
  await execFile("git", ["read-tree", body.base_tree], options);
  for (const entry of body.tree) {
    await execFile(
      "git",
      entry.sha === null
        ? ["update-index", "--force-remove", "--", entry.path]
        : ["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`],
      options,
    );
  }
  return (await execFile("git", ["write-tree"], options)).stdout.trim();
}
