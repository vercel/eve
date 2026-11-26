import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverRepositories,
  discoverWorkspace,
  MAX_DISCOVERED_REPOSITORIES,
  MAX_META_FIELD_BYTES,
  MAX_OVERFLOW_PATHS,
  readRepositoryFile,
  readScopedDirectoryInstructions,
} from "../../extension/lib/repositories.ts";
import { createLocalSandbox, git, initRepo } from "./local-sandbox.ts";

test("discovers multiple repos and worktrees in one command, strips credentials, and prunes node_modules", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "eve-code-repos-multi-")));
  try {
    const repoA = join(workspace, "repos", "a");
    const repoB = join(workspace, "repos", "b");
    const worktreeDir = join(workspace, "repos", "a-wt");
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
    await initRepo(join(workspace, "node_modules", "ignored"), { "AGENTS.md": "Pruned\n" });

    const { sandbox, commands } = createLocalSandbox(workspace);
    const repos = await discoverRepositories(sandbox);

    assert.equal(commands.length, 1);
    assert.equal(repos.length, 3);
    const byRoot = new Map(repos.map((r) => [r.root, r]));
    const foundA = byRoot.get(await realpath(repoA));
    const foundB = byRoot.get(await realpath(repoB));
    const foundWt = byRoot.get(await realpath(worktreeDir));

    assert.equal(foundA?.slug, "vercel/repo-a");
    assert.equal(foundA?.remote, "https://github.com/vercel/repo-a.git");
    assert.equal(foundA?.head, headA);
    assert.equal(foundA?.branch, "main");
    assert.equal(foundA?.sparse, false);
    assert.equal(foundA?.instructions[0]?.source, "worktree");
    assert.equal(foundA?.instructions[0]?.content, "Repo A guide\n");

    assert.equal(foundB?.slug, "acme/repo-b");
    assert.equal(foundB?.head, headB);
    assert.equal(foundB?.instructions[0]?.relativePath, "CLAUDE.md");
    assert.equal(foundB?.instructions[0]?.content, "Repo B guide\n");

    assert.equal(foundWt?.branch, "feature/wt");
    assert.equal(foundWt?.head, headA);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("scan_repos_under traverses breadth-first without starvation and stops at .git boundaries", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "eve-code-repos-bfs-")));
  try {
    const nestedDirs: string[] = [];
    for (let i = 0; i < 35; i += 1) {
      const parent = join(workspace, "aaa-noise", `d${String(i).padStart(2, "0")}`);
      for (let j = 0; j < 32; j += 1)
        nestedDirs.push(join(parent, `s${String(j).padStart(2, "0")}`));
    }
    for (let i = 0; i < nestedDirs.length; i += 64) {
      await Promise.all(nestedDirs.slice(i, i + 64).map((d) => mkdir(d, { recursive: true })));
    }
    const outerRepo = join(workspace, "monorepo");
    const nestedInsideRepo = join(outerRepo, "packages", "nested-repo");
    const hiddenRepo = join(workspace, ".hidden", "dot-repo");
    const siblingRepo = join(workspace, "zzz-repo");
    await initRepo(outerRepo, { "AGENTS.md": "Outer\n" });
    await initRepo(nestedInsideRepo, { "AGENTS.md": "Nested ignored\n" });
    await initRepo(hiddenRepo, { "AGENTS.md": "Hidden\n" });
    await initRepo(siblingRepo, { "AGENTS.md": "Sibling\n" });

    const { sandbox } = createLocalSandbox(workspace);
    const repos = await discoverRepositories(sandbox);
    const expected = [
      await realpath(outerRepo),
      await realpath(hiddenRepo),
      await realpath(siblingRepo),
    ].sort();
    assert.deepEqual(repos.map((r) => r.root).sort(), expected);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("reads HEAD instructions in sparse --no-cone checkout with whitespace fallback for root and scoped subdirs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-repos-sparse-")));
  try {
    const upstream = join(root, "upstream");
    const workspace = join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await initRepo(upstream, {
      "AGENTS.md": "   \n",
      "CLAUDE.md": "Root sparse fallback\n",
      "packages/sub/AGENTS.md": "Sub sparse rules\n",
      "packages/sub/index.ts": "export const x = 1;\n",
    });

    const cloneDir = join(workspace, "sparse-repo");
    await git(workspace, ["clone", "--no-checkout", `file://${upstream}`, cloneDir]);
    await git(cloneDir, ["sparse-checkout", "init", "--no-cone"]);
    await git(cloneDir, ["sparse-checkout", "set", "packages/sub/index.ts"]);
    await git(cloneDir, ["checkout"]);

    const { sandbox } = createLocalSandbox(workspace);
    const [repo] = await discoverRepositories(sandbox);
    assert.ok(repo !== undefined);
    assert.equal(repo.sparse, true);
    assert.equal(repo.instructions[0]?.source, "git");
    assert.equal(repo.instructions[0]?.relativePath, "CLAUDE.md");
    assert.equal(repo.instructions[0]?.content, "Root sparse fallback\n");

    const scoped = await readScopedDirectoryInstructions(sandbox, {
      targetPath: join(cloneDir, "packages", "sub", "index.ts"),
      checkedDirs: new Set(),
      knownRepoRoots: new Set([repo.root]),
    });
    assert.equal(scoped.scopes[0]?.files[0]?.source, "git");
    assert.equal(scoped.scopes[0]?.files[0]?.relativePath, "packages/sub/AGENTS.md");
    assert.equal(scoped.scopes[0]?.files[0]?.content, "Sub sparse rules\n");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("returns unavailable for promisor blobs offline and blocks ext:: RCE and core.fsmonitor (vercel/eve/407)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-repos-407-")));
  try {
    const upstream = join(root, "upstream");
    const workspace = join(root, "ws");
    await mkdir(workspace, { recursive: true });
    await initRepo(upstream, {
      "AGENTS.md": "Promisor instructions\n",
      "src/app.ts": "export const ok = true;\n",
    });
    await git(upstream, ["config", "uploadpack.allowFilter", "true"]);

    const cloneDir = join(workspace, "malicious-partial");
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

    const extMarker = join(root, "ext-rce-marker");
    const fsmonMarker = join(root, "fsmonitor-marker");
    await git(cloneDir, ["config", "protocol.ext.allow", "always"]);
    await git(cloneDir, ["config", "remote.origin.promisor", "true"]);
    await git(cloneDir, ["config", "remote.origin.partialclonefilter", "blob:none"]);
    await git(cloneDir, ["config", "remote.origin.url", `ext::sh -c 'touch ${extMarker}'`]);
    await git(cloneDir, ["config", "core.fsmonitor", `touch ${fsmonMarker}`]);

    const { sandbox } = createLocalSandbox(workspace);
    const repos = await discoverRepositories(sandbox);
    assert.equal(repos.length, 1);
    assert.equal(repos[0]?.instructions[0]?.source, "unavailable");
    assert.equal(repos[0]?.instructions[0]?.content, null);

    const file = await readRepositoryFile(sandbox, cloneDir, "AGENTS.md");
    assert.equal(file?.source, "unavailable");
    assert.equal(file?.content, null);

    await assert.rejects(stat(extMarker), { code: "ENOENT" });
    await assert.rejects(stat(fsmonMarker), { code: "ENOENT" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("blocks symlink exfiltration outside repo and validates public helper options", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-repos-symlink-")));
  try {
    const outsideSecret = join(root, "outside-secret.txt");
    await writeFile(outsideSecret, "TOP_SECRET\n");
    const workspace = join(root, "ws");
    const repoDir = join(workspace, "repo");
    await initRepo(repoDir, { "docs/real.md": "Safe internal guide\n" });

    await symlink(outsideSecret, join(repoDir, "AGENTS.md"));
    await symlink(outsideSecret, join(repoDir, "tracked-link.md"));
    await git(repoDir, ["add", "tracked-link.md"]);
    await git(repoDir, ["commit", "-m", "track symlink"]);
    await rm(join(repoDir, "tracked-link.md"));
    await symlink(join(repoDir, "docs", "real.md"), join(repoDir, "CLAUDE.md"));

    const { sandbox } = createLocalSandbox(workspace);
    assert.equal(await readRepositoryFile(sandbox, repoDir, "AGENTS.md"), null);
    assert.equal(await readRepositoryFile(sandbox, repoDir, "tracked-link.md"), null);
    const internal = await readRepositoryFile(sandbox, repoDir, "CLAUDE.md");
    assert.equal(internal?.source, "worktree");
    assert.equal(internal?.content, "Safe internal guide\n");

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
      discoverRepositories(sandbox, { maxFileBytes: 1.5 }),
      /Invalid maxFileBytes/u,
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

test("discovers external repos via scoped probe, expands $HOME paths, and caches external non-git dirs", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "eve-code-repos-external-")));
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
    const realExternalRepo = await realpath(externalRepo);
    const firstProbe = await readScopedDirectoryInstructions(sandbox, {
      targetPath: join(externalRepo, "packages", "sub", "index.ts"),
      checkedDirs: new Set(),
      knownRepoRoots: new Set(),
    });
    assert.equal(firstProbe.enclosingRepoRoot, realExternalRepo);
    assert.equal(firstProbe.enclosingRepo?.slug, "external/tool");
    assert.equal(firstProbe.enclosingRepo?.instructions[0]?.content, "External repo rules\n");
    assert.equal(firstProbe.checkedDirs.length, 2);
    assert.equal(firstProbe.scopes[0]?.files[0]?.content, "External sub rules\n");

    const secondProbe = await readScopedDirectoryInstructions(sandbox, {
      targetPath: join(externalRepo, "packages", "sub", "other.ts"),
      checkedDirs: new Set(firstProbe.checkedDirs),
      knownRepoRoots: new Set([realExternalRepo]),
    });
    assert.equal(secondProbe.enclosingRepo, null);
    assert.deepEqual(secondProbe.checkedDirs, []);
    assert.deepEqual(secondProbe.scopes, []);

    const homeProbe = await readScopedDirectoryInstructions(sandbox, {
      targetPath: "$HOME/.agents/skills/demo/SKILL.md",
      checkedDirs: new Set(),
    });
    assert.equal(homeProbe.homeDir, await realpath(fakeHome));
    assert.equal(homeProbe.enclosingRepoRoot, null);
    assert.deepEqual(homeProbe.checkedDirs, [await realpath(homeSkillDir)]);
    assert.deepEqual(homeProbe.scopes, []);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("bounds discovered repo count, metadata field size, and aggregate instruction bytes (vercel/eve/459)", async () => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "eve-code-repos-459-")));
  try {
    const repoCount = 36;
    const hugeRemote = `https://github.com/acme/${"r".repeat(12_000)}.git`;
    const repoDirs = Array.from({ length: repoCount }, (_, idx) =>
      join(workspace, `repo-${String(idx).padStart(2, "0")}`),
    );
    for (let i = 0; i < repoDirs.length; i += 8) {
      await Promise.all(
        repoDirs.slice(i, i + 8).map(async (dir, offset) => {
          const idx = i + offset;
          await mkdir(dir, { recursive: true });
          await git(dir, ["init", "-b", "main"]);
          if (idx === 0) await git(dir, ["remote", "add", "origin", hugeRemote]);
          await writeFile(
            join(dir, "AGENTS.md"),
            `Repo ${String(idx).padStart(2, "0")} instructions: ${"x".repeat(60)}\n`,
          );
        }),
      );
    }

    const { sandbox } = createLocalSandbox(workspace);
    const full = await discoverWorkspace(sandbox, { extraPaths: [repoDirs[0]!] });
    assert.equal(full.repositories.length, MAX_DISCOVERED_REPOSITORIES);
    assert.equal(full.overflowPaths.length, repoCount - MAX_DISCOVERED_REPOSITORIES);
    assert.ok(full.overflowPaths.length <= MAX_OVERFLOW_PATHS);

    const hugeRepo = full.repositories.find((r) => r.root === repoDirs[0]);
    assert.ok(hugeRepo?.remote !== null && hugeRepo?.remote !== undefined);
    assert.ok(Buffer.byteLength(hugeRepo.remote, "utf8") <= MAX_META_FIELD_BYTES);

    const budgeted = await discoverWorkspace(sandbox, {
      extraPaths: [repoDirs[0]!],
      maxTotalBytes: 128,
    });
    const emittedFiles = budgeted.repositories.flatMap((r) => r.instructions);
    const emittedBytes = emittedFiles.reduce(
      (sum, f) => sum + Buffer.byteLength(f.content ?? "", "utf8"),
      0,
    );
    assert.equal(emittedFiles.length, 1);
    assert.ok(emittedBytes <= 128);
    assert.ok(budgeted.overflowPaths.some((p) => p.endsWith("/AGENTS.md")));
    assert.ok(budgeted.overflowPaths.length <= MAX_OVERFLOW_PATHS);
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
});
