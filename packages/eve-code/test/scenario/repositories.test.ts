import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  discoverRepositories,
  findEnclosingRepository,
  readRepositoryFile,
  readScopedDirectoryInstructions,
  type RepositorySandbox,
} from "../../extension/lib/repositories.ts";

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Eve Test",
  GIT_AUTHOR_EMAIL: "eve@example.com",
  GIT_COMMITTER_NAME: "Eve Test",
  GIT_COMMITTER_EMAIL: "eve@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, env: GIT_ENV });
  return stdout.trim();
}

function createLocalSandbox(
  root: string,
  envOverrides: NodeJS.ProcessEnv = {},
): {
  readonly sandbox: RepositorySandbox;
  readonly commands: string[];
} {
  const commands: string[] = [];
  return {
    commands,
    sandbox: {
      resolvePath(path: string) {
        return path.startsWith("/") ? path : join(root, path);
      },
      async run({ command }) {
        commands.push(command);
        try {
          const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
            cwd: root,
            env: { ...GIT_ENV, ...envOverrides },
          });
          return { exitCode: 0, stdout, stderr };
        } catch (error) {
          const err = error as { code?: number; stdout?: string; stderr?: string };
          return {
            exitCode: typeof err.code === "number" ? err.code : 1,
            stdout: err.stdout ?? "",
            stderr: err.stderr ?? "",
          };
        }
      },
    },
  };
}

async function initRepo(
  dir: string,
  files: Readonly<Record<string, string>>,
  remote?: string,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, ["init", "-b", "main"]);
  if (remote !== undefined) {
    await git(dir, ["remote", "add", "origin", remote]);
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-m", "init"]);
  return await git(dir, ["rev-parse", "HEAD"]);
}

test("discovers multiple repos and git worktrees in one command, strips remote credentials, and prunes node_modules", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "eve-code-repos-multi-"));
  try {
    const repoA = join(workspace, "repos", "a");
    const repoB = join(workspace, "repos", "b");
    const worktreeDir = join(workspace, "repos", "a-wt");
    const ignoredRepo = join(workspace, "node_modules", "ignored-pkg");

    const headA = await initRepo(
      repoA,
      { "AGENTS.md": "Repo A guide\n" },
      "https://x-access-token:ghs_secret@github.com/vercel/repo-a.git",
    );
    const headB = await initRepo(
      repoB,
      { "AGENTS.md": "   \n\t\n", "CLAUDE.md": "Repo B guide\n" },
      "git@github.com:acme/repo-b.git",
    );
    await git(repoA, ["worktree", "add", "-b", "feature/wt", worktreeDir]);
    await initRepo(ignoredRepo, { "AGENTS.md": "Should be pruned\n" });

    const { sandbox, commands } = createLocalSandbox(workspace);
    const repos = await discoverRepositories(sandbox);

    assert.equal(commands.length, 1, "discovery runs in a single sandbox command");
    assert.equal(repos.length, 3);

    const byRoot = new Map(repos.map((repo) => [repo.root, repo]));
    const realA = await realpath(repoA);
    const realB = await realpath(repoB);
    const realWt = await realpath(worktreeDir);

    const foundA = byRoot.get(realA);
    assert.ok(foundA);
    assert.equal(foundA.slug, "vercel/repo-a");
    assert.equal(foundA.remote, "https://github.com/vercel/repo-a.git");
    assert.equal(foundA.head, headA);
    assert.equal(foundA.branch, "main");
    assert.equal(foundA.sparse, false);
    assert.equal(foundA.instructions.length, 1);
    assert.equal(foundA.instructions[0]?.source, "worktree");
    assert.equal(foundA.instructions[0]?.content, "Repo A guide\n");

    const foundB = byRoot.get(realB);
    assert.ok(foundB);
    assert.equal(foundB.slug, "acme/repo-b");
    assert.equal(foundB.head, headB);
    assert.equal(
      foundB.instructions[0]?.relativePath,
      "CLAUDE.md",
      "whitespace-only AGENTS.md falls back to CLAUDE.md",
    );
    assert.equal(foundB.instructions[0]?.content, "Repo B guide\n");

    const foundWt = byRoot.get(realWt);
    assert.ok(foundWt);
    assert.equal(foundWt.branch, "feature/wt");
    assert.equal(foundWt.head, headA);
    assert.equal(foundWt.instructions[0]?.content, "Repo A guide\n");
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("reads HEAD:AGENTS.md from git when excluded by sparse --no-cone checkout and falls back when whitespace-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-repos-sparse-"));
  try {
    const upstream = join(root, "upstream");
    const workspace = join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await initRepo(upstream, {
      "AGENTS.md": "   \n",
      "CLAUDE.md": "Root sparse fallback instructions\n",
      "packages/sub/AGENTS.md": "Sub sparse instructions\n",
      "packages/sub/index.ts": "export const x = 1;\n",
    });

    const cloneDir = join(workspace, "sparse-repo");
    await git(workspace, ["clone", "--no-checkout", `file://${upstream}`, cloneDir]);
    await git(cloneDir, ["sparse-checkout", "init", "--no-cone"]);
    await git(cloneDir, ["sparse-checkout", "set", "packages/sub/index.ts"]);
    await git(cloneDir, ["checkout"]);

    const { sandbox } = createLocalSandbox(workspace);
    const repos = await discoverRepositories(sandbox);
    assert.equal(repos.length, 1);
    const repo = repos[0]!;
    assert.equal(repo.sparse, true);
    assert.equal(repo.instructions.length, 1);
    assert.equal(repo.instructions[0]?.source, "git");
    assert.equal(repo.instructions[0]?.relativePath, "CLAUDE.md");
    assert.equal(repo.instructions[0]?.content, "Root sparse fallback instructions\n");
    assert.equal(repo.instructions[0]?.truncated, false);

    const scoped = await readScopedDirectoryInstructions(sandbox, {
      targetPath: join(cloneDir, "packages", "sub", "index.ts"),
      checkedDirs: new Set(),
      knownRepoRoots: new Set([repo.root]),
    });
    assert.equal(scoped.scopes.length, 1);
    assert.equal(scoped.scopes[0]?.files[0]?.source, "git");
    assert.equal(scoped.scopes[0]?.files[0]?.relativePath, "packages/sub/AGENTS.md");
    assert.equal(scoped.scopes[0]?.files[0]?.content, "Sub sparse instructions\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("returns source unavailable for promisor blobs when the remote cannot be reached", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-repos-partial-"));
  try {
    const upstream = join(root, "upstream");
    const workspace = join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await initRepo(upstream, {
      "AGENTS.md": "Promisor instructions\n",
      "src/app.ts": "export const ok = true;\n",
    });
    await git(upstream, ["config", "uploadpack.allowFilter", "true"]);

    const cloneDir = join(workspace, "partial-repo");
    await git(workspace, [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      `file://${upstream}`,
      cloneDir,
    ]);
    await git(cloneDir, ["sparse-checkout", "init", "--no-cone"]);
    await git(cloneDir, ["sparse-checkout", "set", "src/app.ts"]);
    await git(cloneDir, ["checkout"]);
    await git(cloneDir, ["remote", "set-url", "origin", "file:///nonexistent-remote-for-test"]);

    const { sandbox } = createLocalSandbox(workspace);
    const file = await readRepositoryFile(sandbox, cloneDir, "AGENTS.md");
    assert.ok(file !== null);
    assert.equal(file.source, "unavailable");
    assert.equal(file.content, null);
    assert.equal(file.truncated, false);
    assert.equal(file.relativePath, "AGENTS.md");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("blocks symlink exfiltration outside the repository and validates public helper options", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-repos-symlink-"));
  try {
    const outsideSecret = join(root, "outside-secret.txt");
    await writeFile(outsideSecret, "TOP_SECRET_VALUE\n");

    const workspace = join(root, "ws");
    const repoDir = join(workspace, "repo");
    await initRepo(repoDir, {
      "docs/real.md": "Safe internal guide\n",
    });

    await symlink(outsideSecret, join(repoDir, "AGENTS.md"));
    await symlink(outsideSecret, join(repoDir, "tracked-link.md"));
    await git(repoDir, ["add", "tracked-link.md"]);
    await git(repoDir, ["commit", "-m", "track symlink"]);
    await rm(join(repoDir, "tracked-link.md"));

    await symlink(join(repoDir, "docs", "real.md"), join(repoDir, "CLAUDE.md"));

    const { sandbox } = createLocalSandbox(workspace);

    const escaped = await readRepositoryFile(sandbox, repoDir, "AGENTS.md");
    assert.equal(escaped, null, "worktree symlink pointing outside repo must not be read");

    const trackedSymlinkBlob = await readRepositoryFile(sandbox, repoDir, "tracked-link.md");
    assert.equal(trackedSymlinkBlob, null, "git 120000 symlink blob must not be read");

    const internalLink = await readRepositoryFile(sandbox, repoDir, "CLAUDE.md");
    assert.ok(internalLink !== null);
    assert.equal(internalLink.source, "worktree");
    assert.equal(internalLink.content, "Safe internal guide\n");

    await assert.rejects(
      readRepositoryFile(sandbox, repoDir, "../outside-secret.txt"),
      /Invalid repository relative path/u,
    );
    await assert.rejects(
      readRepositoryFile(sandbox, repoDir, "CLAUDE.md", { maxFileBytes: 0 }),
      /Invalid maxFileBytes/u,
    );
    await assert.rejects(
      discoverRepositories(sandbox, { roots: ["../escape"] }),
      /Invalid repository root path/u,
    );
    await assert.rejects(
      discoverRepositories(sandbox, { roots: ["/etc"] }),
      /Invalid repository root path/u,
    );
    await assert.rejects(
      discoverRepositories(sandbox, { maxFileBytes: 1.5 }),
      /Invalid maxFileBytes/u,
    );
    await assert.rejects(
      discoverRepositories(sandbox, { instructions: ["../secret.md"] }),
      /Invalid repository instruction path/u,
    );
    await assert.rejects(
      discoverRepositories(sandbox, { instructions: ["/etc/passwd"] }),
      /Invalid repository instruction path/u,
    );
    await assert.rejects(
      discoverRepositories(sandbox, { instructions: [[]] }),
      /fallback tuple must not be empty/u,
    );
    await assert.rejects(
      discoverRepositories(sandbox, { instructions: [["AGENTS.md", "../escape.md"]] }),
      /Invalid repository instruction path/u,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("discovers enclosing repository outside workspace, expands $HOME paths, and caches external non-git dirs", async () => {
  const root = await mkdtemp(join(tmpdir(), "eve-code-repos-external-"));
  try {
    const workspace = join(root, "ws");
    const fakeHome = join(root, "fake-home");
    const externalRepo = join(root, "external-repo");
    const homeSkillDir = join(fakeHome, ".agents", "skills", "demo");
    await mkdir(workspace, { recursive: true });
    await mkdir(homeSkillDir, { recursive: true });
    await writeFile(join(homeSkillDir, "SKILL.md"), "# Demo\n");

    await initRepo(
      externalRepo,
      {
        "AGENTS.md": "External repo rules\n",
        "packages/sub/AGENTS.md": "External sub rules\n",
        "packages/sub/index.ts": "export const y = 2;\n",
      },
      "https://github.com/external/tool.git",
    );

    const { sandbox } = createLocalSandbox(workspace, { HOME: fakeHome });
    const externalFile = join(externalRepo, "packages", "sub", "index.ts");

    const enclosing = await findEnclosingRepository(sandbox, externalFile);
    assert.ok(enclosing !== null);
    assert.equal(enclosing.root, await realpath(externalRepo));
    assert.equal(enclosing.slug, "external/tool");
    assert.equal(enclosing.instructions[0]?.content, "External repo rules\n");

    const firstProbe = await readScopedDirectoryInstructions(sandbox, {
      targetPath: externalFile,
      checkedDirs: new Set(),
      knownRepoRoots: new Set([enclosing.root]),
    });
    assert.equal(firstProbe.enclosingRepoRoot, enclosing.root);
    assert.equal(firstProbe.checkedDirs.length, 2);
    assert.equal(firstProbe.scopes.length, 1);
    assert.equal(firstProbe.scopes[0]?.files[0]?.content, "External sub rules\n");

    const secondProbe = await readScopedDirectoryInstructions(sandbox, {
      targetPath: join(externalRepo, "packages", "sub", "other.ts"),
      checkedDirs: new Set(firstProbe.checkedDirs),
      knownRepoRoots: new Set([enclosing.root]),
    });
    assert.deepEqual(secondProbe.checkedDirs, []);
    assert.deepEqual(secondProbe.scopes, []);

    const homeProbe = await readScopedDirectoryInstructions(sandbox, {
      targetPath: "$HOME/.agents/skills/demo/SKILL.md",
      checkedDirs: new Set(),
    });
    const canonicalHomeSkillDir = await realpath(homeSkillDir);
    assert.equal(homeProbe.homeDir, await realpath(fakeHome));
    assert.equal(homeProbe.enclosingRepoRoot, null);
    assert.deepEqual(homeProbe.checkedDirs, [canonicalHomeSkillDir]);
    assert.deepEqual(homeProbe.scopes, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
