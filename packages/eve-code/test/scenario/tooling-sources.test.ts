import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { DIAGNOSTICS_WORKER_SOURCE, GH_SIGNED_COMMIT_SOURCE } from "../../extension/lib/tooling.ts";
import { installCodeTooling } from "../../extension/lib/sandbox.ts";

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

test("tooling installer shell parses without executing an installation", async () => {
  for (const vercel of [false, true]) {
    await installCodeTooling(
      {
        resolvePath: (path) => `/workspace/quoted ' path/${path}`,
        async writeTextFile() {},
        async run({ command }) {
          await execFileAsync("bash", ["-n", "-c", command]);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
      { vercel },
    );
  }
});

test("signed commit missing-token error names the authenticated gh invocation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eve-code-signed-commit-auth-"));
  try {
    const script = join(dir, "gh-signed-commit.cjs");
    await writeFile(script, GH_SIGNED_COMMIT_SOURCE);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [script, "--repo", "owner/repo", "--branch", "test", "-m", "message"],
        { cwd: dir, env: { GH_TOKEN: "" } },
      ),
      (error: unknown) => {
        const { code, stderr } = error as { code: number; stderr: string };
        assert.equal(code, 1);
        assert.match(stderr, /configured authenticated gh tool/u);
        assert.match(
          stderr,
          /command "gh-signed-commit --repo owner\/name --branch branch -m headline"/u,
        );
        assert.match(stderr, /repository "owner\/name"/u);
        assert.match(stderr, /description.*workingDirectory/u);
        assert.match(stderr, /supplies the credential lease/u);
        assert.doesNotMatch(stderr, /login tool|gh auth login/u);
        return true;
      },
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("signed commit guards tracked work before remote access", async () => {
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
          stderr.includes("preserve them and use a clean worktree") &&
          stderr.includes("stage only changes authorized for this commit") &&
          stderr.includes(
            "Do not stash, revert, or overwrite unrelated user changes without explicit authorization.",
          )
        );
      },
    );
    assert.equal(await readFile(tracked, "utf8"), "unstaged\n");
    assert.equal(
      (await execFileAsync("git", ["show", ":tracked.txt"], { cwd: dir })).stdout,
      "committed\n",
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
