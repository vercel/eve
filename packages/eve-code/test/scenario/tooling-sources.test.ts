import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { DIAGNOSTICS_WORKER_SOURCE, GH_SIGNED_COMMIT_SOURCE } from "../../extension/lib/tooling.ts";

const execFileAsync = promisify(execFile);

test("embedded Node tooling sources parse", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eve-code-tooling-"));
  try {
    const files = [
      ["diagnostics.cjs", DIAGNOSTICS_WORKER_SOURCE],
      ["gh-signed-commit.cjs", GH_SIGNED_COMMIT_SOURCE],
    ] as const;
    for (const [name, source] of files) {
      const path = join(dir, name);
      await writeFile(path, source);
      await execFileAsync(process.execPath, ["--check", path]);
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signed commit guards tracked work before remote access and never hard-resets", async () => {
  assertSignedCommitSourceOrder();
  const dir = await mkdtemp(join(tmpdir(), "eve-code-signed-commit-"));
  try {
    const script = join(dir, "gh-signed-commit.cjs");
    const tracked = join(dir, "tracked.txt");
    await writeFile(script, GH_SIGNED_COMMIT_SOURCE);
    await execFileAsync("git", ["init", "--quiet"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "eve-code test"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "eve-code@example.test"], { cwd: dir });
    await writeFile(tracked, "committed\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: dir });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: dir });
    await writeFile(tracked, "unstaged\n");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [script, "--repo", "owner/repo", "--branch", "test", "-m", "message"],
        { cwd: dir, env: { ...process.env, GH_TOKEN: "not-used" } },
      ),
      (error: unknown) => {
        const stderr = String((error as { stderr?: string }).stderr);
        return (
          stderr.includes("unstaged tracked changes would be unsafe") &&
          stderr.includes("stage them, stash or revert unrelated changes, or use a clean worktree")
        );
      },
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signed commit advances HEAD without rewriting the worktree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eve-code-signed-commit-happy-"));
  const remote = join(dir, "remote.git");
  const worktree = join(dir, "worktree");
  try {
    await execFileAsync("git", ["init", "--quiet", "--bare", remote]);
    await execFileAsync("git", ["init", "--quiet", worktree]);
    await execFileAsync("git", ["config", "user.name", "eve-code test"], { cwd: worktree });
    await execFileAsync("git", ["config", "user.email", "eve-code@example.test"], {
      cwd: worktree,
    });
    await writeFile(join(worktree, "tracked.txt"), "before\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: worktree });
    await execFileAsync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: worktree });
    await execFileAsync("git", ["branch", "-M", "test"], { cwd: worktree });
    await execFileAsync("git", ["remote", "add", "origin", remote], { cwd: worktree });
    await execFileAsync("git", ["push", "--quiet", "-u", "origin", "test"], { cwd: worktree });
    const { stdout: oldHeadOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: worktree,
    });
    const oldHead = oldHeadOutput.trim();

    await writeFile(join(worktree, "tracked.txt"), "after\n");
    await writeFile(join(worktree, "untracked.txt"), "preserved\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: worktree });
    const { stdout: treeOutput } = await execFileAsync("git", ["write-tree"], { cwd: worktree });
    const { stdout: newHeadOutput } = await execFileAsync(
      "git",
      ["commit-tree", treeOutput.trim(), "-p", oldHead, "-m", "signed fixture"],
      { cwd: worktree },
    );
    const newHead = newHeadOutput.trim();
    await execFileAsync(
      "git",
      ["push", "--quiet", "--force", "origin", `${newHead}:refs/heads/test`],
      {
        cwd: worktree,
      },
    );

    const script = join(dir, "gh-signed-commit.cjs");
    const preload = join(dir, "fetch.cjs");
    await writeFile(script, GH_SIGNED_COMMIT_SOURCE);
    await writeFile(
      preload,
      `globalThis.fetch = async (url) => {\n  if (String(url).endsWith("/graphql")) return Response.json({ data: { createCommitOnBranch: { commit: { oid: process.env.NEW_HEAD } } } });\n  return Response.json({ object: { sha: process.env.OLD_HEAD } });\n};\n`,
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [script, "--repo", "owner/repo", "--branch", "test", "-m", "signed fixture"],
      {
        cwd: worktree,
        env: {
          ...process.env,
          GH_TOKEN: "not-used",
          NEW_HEAD: newHead,
          NODE_OPTIONS: `--require=${preload}`,
          OLD_HEAD: oldHead,
        },
      },
    );

    assert.equal(stdout.trim(), newHead);
    assert.equal(
      (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree })).stdout.trim(),
      newHead,
    );
    assert.equal(
      (await execFileAsync("git", ["status", "--short"], { cwd: worktree })).stdout,
      "?? untracked.txt\n",
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

function assertSignedCommitSourceOrder() {
  const guard = GH_SIGNED_COMMIT_SOURCE.indexOf("ensureNoUnstagedTrackedChanges();");
  const firstRemoteRead = GH_SIGNED_COMMIT_SOURCE.indexOf("await branchHead(options.branch)");
  const graphql = GH_SIGNED_COMMIT_SOURCE.indexOf('fetch(api + "/graphql"');
  const fetch = GH_SIGNED_COMMIT_SOURCE.indexOf('git("fetch", "origin", options.branch)');
  assert.ok(guard >= 0 && guard < firstRemoteRead && firstRemoteRead < graphql && graphql < fetch);
  assert.match(GH_SIGNED_COMMIT_SOURCE, /git\("reset", "--soft", "FETCH_HEAD"\)/u);
  assert.doesNotMatch(GH_SIGNED_COMMIT_SOURCE, /git\("reset", "--hard"/u);
}
