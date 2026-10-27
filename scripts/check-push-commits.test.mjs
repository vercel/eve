import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("pre-push rejects invalid new commits but allows valid commits and existing history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-pre-push-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  await mkdir(repo);
  await mkdir(join(repo, "empty-hooks"));
  await symlink(resolve("scripts"), join(repo, "scripts"), "dir");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-q");
  git("config", "user.name", "Test Author");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", remote);
  await writeFile(join(repo, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-qm", "Old unclassified history");
  const base = git("rev-parse", "HEAD");
  git("push", "-q", "-u", "origin", "HEAD:refs/heads/main");
  git("config", "core.hooksPath", resolve(".githooks"));
  git("switch", "-qc", "invalid", base);
  await writeFile(join(repo, "file.txt"), "invalid\n");
  git("add", "file.txt");
  git("-c", "core.hooksPath=empty-hooks", "commit", "-qm", "Unclassified change");
  await writeFile(join(repo, "file.txt"), "valid follow-up\n");
  git("add", "file.txt");
  git("-c", "core.hooksPath=empty-hooks", "commit", "-qm", "fix(eve): Follow up");
  assert.throws(
    () => git("push", "-q", "-u", "origin", "invalid"),
    (error) => {
      assert.match(error.stderr.toString(), /Unclassified change/u);
      return true;
    },
  );
  git("switch", "-qc", "valid", base);
  await writeFile(join(repo, "file.txt"), "valid\n");
  git("add", "file.txt");
  git("-c", "core.hooksPath=empty-hooks", "commit", "-qm", "feat(eve): Add a feature");
  git("push", "-q", "-u", "origin", "valid");
  git("switch", "-qc", "side");
  await writeFile(join(repo, "side.txt"), "side\n");
  git("add", "side.txt");
  git("-c", "core.hooksPath=empty-hooks", "commit", "-qm", "fix(eve): Repair a feature");
  git("switch", "-q", "valid");
  await writeFile(join(repo, "main.txt"), "main\n");
  git("add", "main.txt");
  git("-c", "core.hooksPath=empty-hooks", "commit", "-qm", "chore: Update tooling");
  git("-c", "core.hooksPath=empty-hooks", "merge", "--no-ff", "--no-edit", "side");
  git("push", "-q", "origin", "valid");
  await writeFile(join(repo, "file.txt"), "new invalid\n");
  git("add", "file.txt");
  git("-c", "core.hooksPath=empty-hooks", "commit", "-qm", "Another unclassified change");
  assert.throws(
    () => git("push", "-q", "origin", "valid"),
    (error) => {
      assert.match(error.stderr.toString(), /Another unclassified change/u);
      return true;
    },
  );
});
