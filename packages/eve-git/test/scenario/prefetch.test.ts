import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { promisify } from "node:util";

import { buildPrefetchCommand, DEFAULT_PREFETCH_FILES } from "../../extension/lib/prefetch.ts";

const execFileAsync = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "eve-git test",
  GIT_AUTHOR_EMAIL: "eve-git@example.test",
  GIT_COMMITTER_NAME: "eve-git test",
  GIT_COMMITTER_EMAIL: "eve-git@example.test",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
};

let dir: string;
let workspace: string;
let remote: string;
let work: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eve-git-prefetch-"));
  workspace = join(dir, "workspace");
  remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  work = join(workspace, "work");

  await mkdir(workspace, { recursive: true });
  await git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  await git(remote, "config", "uploadpack.allowFilter", "true");
  await git(dir, "clone", "--quiet", remote, seed);
  await mkdir(join(seed, "docs"), { recursive: true });
  await mkdir(join(seed, "nested"), { recursive: true });
  await writeFile(join(seed, "AGENTS.md"), "# Agent rules\nRun focused tests.\n");
  await writeFile(join(seed, "docs", "GUIDE.md"), "Subdir guide.\n");
  await writeFile(join(seed, "nested", "file.txt"), "Tree entry content.\n");
  await symlink("AGENTS.md", join(seed, "LINK.md"));
  await writeFile(join(seed, "README.md"), "Not prefetched.\n");
  await git(seed, "add", "-A");
  await git(seed, "commit", "--quiet", "-m", "fixture");
  await git(seed, "push", "--quiet", "origin", "main");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("prefetches regular blobs into .git/objects without fetching symlinks, trees, or touching the worktree", async () => {
  await git(
    dir,
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--no-checkout",
    `file://${remote}`,
    work,
  );

  await assert.rejects(
    execFileAsync("git", ["-C", work, "show", "HEAD:AGENTS.md"], {
      env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
    }),
  );

  const command = buildPrefetchCommand(work, workspace, [
    ...DEFAULT_PREFETCH_FILES,
    "docs/GUIDE.md",
    "LINK.md",
    "nested",
  ]);
  assert.ok(command);
  await execFileAsync("/bin/sh", ["-c", command], { env: ENV });

  assert.equal(existsSync(join(work, "AGENTS.md")), false);
  assert.equal(existsSync(join(work, "docs", "GUIDE.md")), false);

  const agents = await execFileAsync("git", ["-C", work, "show", "HEAD:AGENTS.md"], {
    env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
  });
  assert.equal(agents.stdout, "# Agent rules\nRun focused tests.\n");

  const guide = await execFileAsync("git", ["-C", work, "show", "HEAD:docs/GUIDE.md"], {
    env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
  });
  assert.equal(guide.stdout, "Subdir guide.\n");

  for (const uncached of ["HEAD:LINK.md", "HEAD:nested/file.txt", "HEAD:README.md"]) {
    await assert.rejects(
      execFileAsync("git", ["-C", work, "show", uncached], {
        env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
      }),
      uncached,
    );
  }
});

test("skips repos outside the canonical workspace when reached via a symlink", async () => {
  const outside = join(dir, "outside");
  const escapedLink = join(workspace, "escaped");
  await git(
    dir,
    "clone",
    "--quiet",
    "--filter=blob:none",
    "--no-checkout",
    `file://${remote}`,
    outside,
  );
  await symlink(outside, escapedLink);

  const command = buildPrefetchCommand(escapedLink, workspace, DEFAULT_PREFETCH_FILES);
  assert.ok(command);
  await execFileAsync("/bin/sh", ["-c", command], { env: ENV });

  await assert.rejects(
    execFileAsync("git", ["-C", outside, "show", "HEAD:AGENTS.md"], {
      env: { ...ENV, GIT_NO_LAZY_FETCH: "1" },
    }),
  );
});

test("exits cleanly on non-partial clones without error", async () => {
  await git(dir, "clone", "--quiet", `file://${remote}`, work);
  const command = buildPrefetchCommand(work, workspace, DEFAULT_PREFETCH_FILES);
  assert.ok(command);
  const result = await execFileAsync("/bin/sh", ["-c", command], { env: ENV });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", args, { cwd, env: ENV })).stdout.trim();
}
