import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { revisionSubject, workingTreeSubject } from "./source.mjs";

test("archives the working tree without changing the index", () => {
  const repository = repositoryFixture();
  try {
    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    writeFileSync(join(repository, "new.txt"), "new\n");
    writeFileSync(join(repository, "ignored.txt"), "ignored\n");
    rmSync(join(repository, "deleted.txt"));
    const statusBefore = git(repository, ["status", "--porcelain"]);

    const subject = workingTreeSubject(repository);
    withExtracted(subject.archive, (extracted) => {
      assert.equal(readFileSync(join(extracted, "tracked.txt"), "utf8"), "changed\n");
      assert.equal(readFileSync(join(extracted, "new.txt"), "utf8"), "new\n");
      assert.equal(existsSync(join(extracted, "ignored.txt")), false);
      assert.equal(existsSync(join(extracted, "deleted.txt")), false);
    });
    assert.equal(git(repository, ["status", "--porcelain"]), statusBefore);
    writeFileSync(join(repository, "tracked.txt"), "another source change\n");
    const sourceChange = workingTreeSubject(repository);
    assert.notEqual(sourceChange.digest, subject.digest);
    assert.equal(sourceChange.dependencyDigest, subject.dependencyDigest);
    writeFileSync(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.1'\n");
    assert.notEqual(workingTreeSubject(repository).dependencyDigest, subject.dependencyDigest);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("archives a local revision", () => {
  const repository = repositoryFixture();
  try {
    writeFileSync(join(repository, "tracked.txt"), "working tree\n");
    const subject = revisionSubject(repository, "HEAD", "base");
    assert.equal(subject.label, "base");
    withExtracted(subject.archive, (extracted) => {
      assert.equal(readFileSync(join(extracted, "tracked.txt"), "utf8"), "committed\n");
    });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

function repositoryFixture() {
  const repository = mkdtempSync(join(tmpdir(), "eve-authoring-source-test-"));
  git(repository, ["init", "--quiet"]);
  git(repository, ["config", "user.name", "Test"]);
  git(repository, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(repository, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repository, ".npmrc"), "link-workspace-packages=true\n");
  writeFileSync(join(repository, "package.json"), '{"private":true}\n');
  writeFileSync(join(repository, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(repository, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(repository, "tracked.txt"), "committed\n");
  writeFileSync(join(repository, "deleted.txt"), "delete me\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "--quiet", "-m", "fixture"]);
  return repository;
}

function withExtracted(archive, assertion) {
  const directory = mkdtempSync(join(tmpdir(), "eve-authoring-archive-test-"));
  const archivePath = join(directory, "source.tar.gz");
  const extracted = join(directory, "extracted");
  try {
    writeFileSync(archivePath, archive);
    execFileSync("mkdir", [extracted]);
    execFileSync("tar", ["-xzf", archivePath, "-C", extracted]);
    assertion(extracted);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
