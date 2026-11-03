import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";

import { GH_SIGNED_COMMIT_SOURCE } from "../../extension/lib/signed-commit.ts";

const execFileAsync = promisify(execFile);

// Serves the GitHub calls gh-signed-commit makes from a bare repository, so the
// published history can be inspected with git.
const FAKE_GITHUB = String.raw`
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const remote = process.env.FAKE_GITHUB_REMOTE;
const git = (args, options = {}) =>
  execFileSync("git", ["--git-dir", remote, ...args], { encoding: "utf8", ...options }).trim();
const exists = (args) => {
  try {
    return git(args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  const { pathname } = new URL(String(url));
  fs.appendFileSync(process.env.FAKE_GITHUB_LOG, method + " " + pathname + "\n");
  let match;
  if (method === "GET" && (match = pathname.match(/\/git\/ref\/heads%2F(.+)$/))) {
    const sha = exists(["rev-parse", "--verify", "refs/heads/" + decodeURIComponent(match[1])]);
    return sha ? Response.json({ object: { sha } }) : Response.json({}, { status: 404 });
  }
  if (method === "GET" && (match = pathname.match(/\/git\/commits\/([0-9a-f]+)$/))) {
    return exists(["cat-file", "-e", match[1] + "^{commit}"]) === null
      ? Response.json({}, { status: 404 })
      : Response.json({ sha: match[1] });
  }
  if (method === "POST" && pathname.endsWith("/git/refs")) {
    const { ref, sha } = JSON.parse(init.body);
    git(["update-ref", ref, sha, ""]);
    return Response.json({ ref, object: { sha } }, { status: 201 });
  }
  if (method === "POST" && pathname === "/graphql") {
    const { input } = JSON.parse(init.body).variables;
    const env = {
      ...process.env,
      GIT_INDEX_FILE: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-github-")), "index"),
    };
    git(["read-tree", input.expectedHeadOid], { env });
    for (const { path: file, contents } of input.fileChanges.additions) {
      const blob = git(["hash-object", "-w", "--stdin"], { input: Buffer.from(contents, "base64") });
      git(["update-index", "--add", "--cacheinfo", "100644," + blob + "," + file], { env });
    }
    for (const { path: file } of input.fileChanges.deletions) {
      git(["update-index", "--index-info"], { env, input: "0 " + "0".repeat(40) + "\t" + file + "\n" });
    }
    const tree = git(["write-tree"], { env });
    const oid = git(["commit-tree", tree, "-p", input.expectedHeadOid, "-m", input.message.headline]);
    git(["update-ref", "refs/heads/" + input.branch.branchName, oid, input.expectedHeadOid]);
    return Response.json({ data: { createCommitOnBranch: { commit: { oid } } } });
  }
  throw new Error("unexpected GitHub request: " + method + " " + pathname);
};
`;

const IDENTITY = {
  GIT_AUTHOR_NAME: "eve-git test",
  GIT_AUTHOR_EMAIL: "eve-git@example.test",
  GIT_COMMITTER_NAME: "eve-git test",
  GIT_COMMITTER_EMAIL: "eve-git@example.test",
};

let dir: string;
let remote: string;
let upstream: string;
let sandbox: string;
let log: string;
let script: string;
let preload: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eve-git-signed-commit-"));
  remote = join(dir, "remote.git");
  upstream = join(dir, "upstream");
  sandbox = join(dir, "sandbox");
  log = join(dir, "github.log");
  script = join(dir, "gh-signed-commit.cjs");
  preload = join(dir, "fake-github.cjs");
  await writeFile(script, GH_SIGNED_COMMIT_SOURCE);
  await writeFile(preload, FAKE_GITHUB);
  await writeFile(log, "");
  await git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  await git(dir, "clone", "--quiet", remote, upstream);
  await commitFile(upstream, "app.txt", "v1\n");
  await git(upstream, "push", "--quiet", "origin", "HEAD:main");
  await git(dir, "clone", "--quiet", remote, sandbox);
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

test("a new branch starts at local HEAD, so later pushes keep newer main commits", async () => {
  const clonedMain = await rev(sandbox, "HEAD");
  // main moves on after the sandbox cloned, as in a long-running thread.
  await commitFile(upstream, "security.txt", "fixed\n");
  await git(upstream, "push", "--quiet", "origin", "HEAD:main");

  await stage(sandbox, "feature.txt", "first\n");
  await signedCommit("first");
  await stage(sandbox, "feature.txt", "second\n");
  await signedCommit("second");

  assert.deepEqual(await changedSinceMain("feature"), ["feature.txt"]);
  assert.equal(await show("feature:feature.txt"), "second\n");
  assert.equal(await rev(remote, "feature~2"), clonedMain);
});

for (const [name, moveBranch] of [
  [
    "someone else pushes to the branch",
    async () => {
      await git(upstream, "fetch", "--quiet", "origin", "feature");
      await git(upstream, "checkout", "--quiet", "-B", "feature", "FETCH_HEAD");
      await commitFile(upstream, "review.txt", "suggestion\n");
      await git(upstream, "push", "--quiet", "origin", "feature");
    },
  ],
  [
    "the branch is updated from main",
    async () => {
      await commitFile(upstream, "security.txt", "fixed\n");
      await git(upstream, "push", "--quiet", "origin", "HEAD:main");
      await git(upstream, "fetch", "--quiet", "origin", "feature");
      await git(upstream, "checkout", "--quiet", "-B", "feature", "FETCH_HEAD");
      await git(upstream, "merge", "--quiet", "--no-ff", "--no-edit", "main");
      await git(upstream, "push", "--quiet", "origin", "feature");
    },
  ],
] as const) {
  test(`refuses without writing when ${name}, and succeeds after a fast-forward pull`, async () => {
    await stage(sandbox, "feature.txt", "first\n");
    await signedCommit("first");
    await moveBranch();
    const movedTip = await rev(remote, "feature");
    const requests = await readFile(log, "utf8");

    await stage(sandbox, "feature.txt", "second\n");
    await assert.rejects(signedCommit("second"), (error: unknown) => {
      const { code, stderr } = error as { code: number; stderr: string };
      assert.equal(code, 1);
      assert.match(stderr, /local HEAD [0-9a-f]{40} is not the tip of feature/u);
      assert.match(stderr, /git pull --ff-only origin feature through the authenticated gh tool/u);
      assert.match(stderr, /run gh-signed-commit again/u);
      return true;
    });
    assert.equal(await rev(remote, "feature"), movedTip);
    const attempted = (await readFile(log, "utf8")).slice(requests.length);
    assert.doesNotMatch(attempted, /^POST /mu);

    await git(sandbox, "pull", "--quiet", "--ff-only", "origin", "feature");
    await signedCommit("second");
    assert.equal(await rev(remote, "feature^"), movedTip);
    assert.deepEqual(
      (await git(dir, "--git-dir", remote, "diff", "--name-only", movedTip, "feature")).split("\n"),
      ["feature.txt"],
    );
  });
}

test("refuses to start a branch at a local commit GitHub does not have", async () => {
  await commitFile(sandbox, "local.txt", "unpushed\n");
  await stage(sandbox, "feature.txt", "first\n");
  await assert.rejects(signedCommit("first"), (error: unknown) => {
    const { stderr } = error as { stderr: string };
    assert.match(stderr, /local HEAD [0-9a-f]{40} does not exist on GitHub/u);
    assert.match(stderr, /never local commits/u);
    return true;
  });
  await assert.rejects(rev(remote, "feature"));
  assert.doesNotMatch(await readFile(log, "utf8"), /^POST /mu);
});

async function signedCommit(message: string) {
  return execFileAsync(
    process.execPath,
    [script, "--repo", "owner/repo", "--branch", "feature", "-m", message],
    {
      cwd: sandbox,
      env: {
        ...process.env,
        ...IDENTITY,
        FAKE_GITHUB_LOG: log,
        FAKE_GITHUB_REMOTE: remote,
        GH_TOKEN: "not-used",
        NODE_OPTIONS: `--require=${preload}`,
      },
    },
  );
}

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...IDENTITY },
  });
  return stdout.trim();
}

async function rev(repository: string, ref: string) {
  return git(repository, "rev-parse", "--verify", "--quiet", ref);
}

async function show(object: string) {
  return (await execFileAsync("git", ["--git-dir", remote, "show", object])).stdout;
}

async function stage(cwd: string, file: string, contents: string) {
  await writeFile(join(cwd, file), contents);
  await git(cwd, "add", file);
}

async function commitFile(cwd: string, file: string, contents: string) {
  await stage(cwd, file, contents);
  await git(cwd, "commit", "--quiet", "-m", `update ${file}`);
}

async function changedSinceMain(branch: string) {
  const base = await git(dir, "--git-dir", remote, "merge-base", "main", branch);
  return (await git(dir, "--git-dir", remote, "diff", "--name-only", base, branch)).split("\n");
}
