import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";

import { GH_SIGNED_COMMIT_SOURCE } from "../../extension/lib/signed-commit.ts";

const execFileAsync = promisify(execFile);
const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "eve-git test",
  GIT_AUTHOR_EMAIL: "eve-git@example.test",
  GIT_COMMITTER_NAME: "eve-git test",
  GIT_COMMITTER_EMAIL: "eve-git@example.test",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "core.hooksPath",
  GIT_CONFIG_VALUE_1: "/dev/null",
};

const FAKE_GITHUB = String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const remote = process.env.FAKE_REMOTE;
const git = (args, options = {}) => execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8", ...options }).trim();
globalThis.fetch = async (url, init = {}) => {
  const pathname = new URL(url).pathname;
  const write = init.method === "POST" && (pathname !== "/graphql" || JSON.parse(init.body).query.startsWith("mutation"));
  fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ url, write }) + "\n");
  if (pathname === "/repos/owner/repo") return Response.json({ default_branch: "main" });
  if (pathname.includes("/git/ref/")) {
    const ref = decodeURIComponent(pathname.split("/git/ref/")[1]);
    try { return Response.json({ object: { sha: git(["rev-parse", "--verify", "refs/" + ref], { stdio: ["ignore", "pipe", "ignore"] }) } }); }
    catch { return Response.json({}, { status: 404 }); }
  }
  if (pathname.endsWith("/git/refs")) {
    const { ref, sha } = JSON.parse(init.body);
    git(["update-ref", ref, sha, ""]);
    return Response.json({ object: { sha } }, { status: 201 });
  }
  if (pathname === "/graphql") {
    const { query, variables } = JSON.parse(init.body);
    if (query.startsWith("query")) {
      const repository = {};
      for (const [, alias, oid] of query.matchAll(/(c\d+): object\(oid: "([0-9a-f]+)"\)/g)) {
        try {
          git(["cat-file", "-e", oid + "^{commit}"], { stdio: ["ignore", "pipe", "ignore"] });
          repository[alias] = { oid };
        } catch { repository[alias] = null; }
      }
      return Response.json({ data: { repository } });
    }
    const { input } = variables;
    const env = { ...process.env, GIT_INDEX_FILE: path.join(path.dirname(remote), "api-index") };
    git(["read-tree", input.expectedHeadOid], { env });
    for (const { path: file } of input.fileChanges.deletions) git(["update-index", "-z", "--index-info"], { env, input: "0 " + "0".repeat(40) + "\t" + file + "\0" });
    for (const { path: file, contents } of input.fileChanges.additions) {
      const blob = git(["hash-object", "-w", "--stdin"], { input: Buffer.from(contents, "base64") });
      git(["update-index", "--add", "--cacheinfo", "100644," + blob + "," + file], { env });
    }
    const oid = git(["commit-tree", git(["write-tree"], { env }), "-p", input.expectedHeadOid, "-m", input.message.headline]);
    git(["update-ref", "refs/heads/" + input.branch.branchName, oid, input.expectedHeadOid]);
    return Response.json({ data: { createCommitOnBranch: { commit: { oid } } } });
  }
  throw new Error("Unexpected request: " + url);
};
`;

let dir: string;
let remote: string;
let work: string;
let log: string;
let script: string;
let preload: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eve-git-file-safety-"));
  remote = join(dir, "remote.git");
  work = join(dir, "work");
  log = join(dir, "requests.jsonl");
  script = join(dir, "gh-signed-commit.cjs");
  preload = join(dir, "github.cjs");
  await writeFile(script, GH_SIGNED_COMMIT_SOURCE);
  await writeFile(preload, FAKE_GITHUB);
  await writeFile(log, "");
  await git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  await git(dir, "clone", "--quiet", remote, work);
  await writeFile(join(work, "file.txt"), "original\n");
  await writeFile(join(work, "existing.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(join(work, "existing.sh"), 0o755);
  await symlink("file.txt", join(work, "existing-link"));
  await git(work, "add", "-A");
  await git(work, "commit", "--quiet", "-m", "fixture");
  await git(work, "push", "--quiet", "origin", "main");
  await git(work, "config", `url.${remote}.insteadOf`, "https://github.com/owner/repo");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("publishes literal stage-like paths and safely deletes non-regular entries", async () => {
  await writeFile(join(work, "file.txt"), "different staged contents\n");
  const paths = [
    "0:file.txt",
    "1:file.txt",
    "2:file.txt",
    "3:file.txt",
    ":file.txt",
    "line\nbreak.txt",
  ];
  for (const path of paths) await writeFile(join(work, path), `contents of ${path}\n`);
  await rm(join(work, "existing.sh"));
  await rm(join(work, "existing-link"));
  await git(work, "add", "-A");
  const expectedTree = await git(work, "write-tree");
  await writeFile(join(work, "untracked.txt"), "preserve me\n");

  const { stdout } = await publish();

  assert.equal(await git(remote, "rev-parse", "feature^{tree}"), expectedTree);
  assert.equal(await git(work, "rev-parse", "HEAD"), stdout.trim());
  assert.equal(await git(work, "status", "--porcelain"), "?? untracked.txt");
  for (const path of paths)
    assert.equal(await readFile(join(work, path), "utf8"), `contents of ${path}\n`);
  assert.equal(await readFile(join(work, "untracked.txt"), "utf8"), "preserve me\n");
});

for (const kind of [
  "new executable",
  "mode change",
  "executable edit",
  "new symlink",
  "type change",
  "submodule",
] as const) {
  const localCommit = kind === "new executable";
  test(`rejects a ${kind}${localCommit ? " in a local commit" : ""} before writing to GitHub and preserves the checkout`, async () => {
    let path = "changed";
    if (kind === "new executable") {
      await writeFile(join(work, path), "#!/bin/sh\nexit 1\n");
      await chmod(join(work, path), 0o755);
    } else if (kind === "mode change") {
      path = "file.txt";
      await chmod(join(work, path), 0o755);
    } else if (kind === "executable edit") {
      path = "existing.sh";
      await writeFile(join(work, path), "#!/bin/sh\nexit 1\n");
    } else if (kind === "new symlink") {
      await symlink("file.txt", join(work, path));
    } else if (kind === "type change") {
      path = "existing-link";
      await rm(join(work, path));
      await writeFile(join(work, path), "regular file\n");
    }
    await git(work, "add", "-A");
    if (kind === "submodule") {
      await mkdir(join(work, path));
      await git(
        work,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${await git(work, "rev-parse", "HEAD")},${path}`,
      );
    }
    if (localCommit) await git(work, "commit", "--quiet", "-m", "local executable");
    await writeFile(join(work, "untracked.txt"), "preserve me\n");
    const before = {
      tree: await git(work, "write-tree"),
      head: await git(work, "rev-parse", "HEAD"),
      status: await git(work, "status", "--porcelain"),
    };

    await assert.rejects(publish(), (error: unknown) => {
      const { code, stderr } = error as { code: number; stderr: string };
      assert.equal(code, 1);
      assert.match(stderr, /cannot safely publish/u);
      assert.ok(stderr.includes(JSON.stringify(path)));
      assert.match(stderr, /signing key.*staged changes are preserved/u);
      return true;
    });

    assert.doesNotMatch(await readFile(log, "utf8"), /"write":true/u);
    assert.equal(await git(work, "write-tree"), before.tree);
    assert.equal(await git(work, "rev-parse", "HEAD"), before.head);
    assert.equal(await git(work, "status", "--porcelain"), before.status);
    assert.equal(await readFile(join(work, "untracked.txt"), "utf8"), "preserve me\n");
    await assert.rejects(git(remote, "rev-parse", "--verify", "refs/heads/feature"));
  });
}

async function git(cwd: string, ...args: string[]) {
  return (await execFileAsync("git", args, { cwd, env: ENV })).stdout.trim();
}

async function publish() {
  return execFileAsync(
    process.execPath,
    [script, "--repo", "owner/repo", "--branch", "feature", "-m", "publish files"],
    {
      cwd: work,
      env: {
        ...ENV,
        GH_TOKEN: "not-used",
        NODE_OPTIONS: `--require=${preload}`,
        FAKE_REMOTE: remote,
        FAKE_LOG: log,
      },
    },
  );
}
