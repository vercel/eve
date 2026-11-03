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
    if (process.env.FAKE_GITHUB_RACE) {
      // Someone else pushes right after the commit, before the script fetches.
      const blob = git(["hash-object", "-w", "--stdin"], { input: "raced\n" });
      git(["update-index", "--add", "--cacheinfo", "100644," + blob + ",race.txt"], { env });
      const raced = git(["commit-tree", git(["write-tree"], { env }), "-p", oid, "-m", "race"]);
      git(["update-ref", "refs/heads/" + input.branch.branchName, raced, oid]);
    }
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

const REPO_URL = "https://github.com/owner/repo";

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
  await git(sandbox, "config", `url.${remote}.insteadOf`, REPO_URL);
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

test("a branch cut from an older clone of main never reverts newer main commits", async () => {
  const clonedMain = await rev(sandbox, "HEAD");
  // main moves on after the sandbox cloned, as in a long-running thread.
  await commitFile(upstream, "security.txt", "fixed\n");
  await git(upstream, "push", "--quiet", "origin", "HEAD:main");

  await stage(sandbox, "feature.txt", "first\n");
  await signedCommit("first");
  // Larger than execFileSync's default 1 MiB maxBuffer, like a monorepo lockfile.
  const large = "second\n".repeat(200_000);
  await stage(sandbox, "feature.txt", large);
  await writeFile(join(sandbox, "untracked.txt"), "preserved\n");
  const { stdout } = await signedCommit("second");

  assert.deepEqual(await changedSinceMain("feature"), ["feature.txt"]);
  assert.equal(await show("feature:feature.txt"), large);
  assert.equal(await rev(remote, "feature~2"), clonedMain);
  assert.equal(await rev(sandbox, "HEAD"), stdout.trim());
  assert.equal(await git(sandbox, "status", "--porcelain"), "?? untracked.txt");
});

test("syncs to the commit it made even when the branch moves right after", async () => {
  await stage(sandbox, "feature.txt", "first\n");
  const { stdout } = await signedCommit("first", { FAKE_GITHUB_RACE: "1" });

  assert.equal(await rev(sandbox, "HEAD"), stdout.trim());
  assert.equal(await rev(remote, "feature^"), stdout.trim());
  assert.equal(await git(sandbox, "status", "--porcelain"), "");
});

test("refuses with nothing to commit before writing to GitHub", async () => {
  await assert.rejects(signedCommit("empty"), /nothing to commit/u);
  assert.doesNotMatch(await readFile(log, "utf8"), /^POST /mu);
  await assert.rejects(rev(remote, "feature"));
});

const LINES = Array.from({ length: 20 }, (_, index) => `line ${index}`);
const lines = (first: string, last: string) =>
  [first, ...LINES.slice(1, 19), last].join("\n") + "\n";

for (const [name, moveBranch] of [
  [
    "someone else pushes to the branch",
    async () => {
      await checkoutRemoteFeature(upstream);
      await commitFile(upstream, "review.txt", "suggestion\n");
      await git(upstream, "push", "--quiet", "origin", "feature");
    },
  ],
  [
    "someone else edits the same file",
    async () => {
      await checkoutRemoteFeature(upstream);
      await commitFile(upstream, "feature.txt", lines("reviewed", LINES[19]!));
      await git(upstream, "push", "--quiet", "origin", "feature");
    },
  ],
  [
    "the branch is updated from main",
    async () => {
      await commitFile(upstream, "security.txt", "fixed\n");
      await git(upstream, "push", "--quiet", "origin", "HEAD:main");
      await checkoutRemoteFeature(upstream);
      await git(upstream, "merge", "--quiet", "--no-ff", "--no-edit", "main");
      await git(upstream, "push", "--quiet", "origin", "feature");
    },
  ],
] as const) {
  test(`refuses without writing when ${name}, and succeeds after the advised rebase`, async () => {
    await stage(sandbox, "feature.txt", lines(LINES[0]!, LINES[19]!));
    await signedCommit("first");
    await moveBranch();
    const movedTip = await rev(remote, "feature");
    const movedFile = await show("feature:feature.txt");

    await stage(sandbox, "feature.txt", lines(LINES[0]!, "edited"));
    await assertRefused("second", [
      new RegExp(`feature is at ${movedTip}, which this checkout lacks`, "u"),
      new RegExp(`git pull --rebase ${REPO_URL} feature through the authenticated gh tool`, "u"),
    ]);
    assert.equal(await rev(remote, "feature"), movedTip);

    await git(sandbox, "commit", "--quiet", "-m", "local");
    await git(sandbox, "pull", "--quiet", "--rebase", REPO_URL, "feature");
    await signedCommit("second");
    assert.equal(await rev(remote, "feature^"), movedTip);
    assert.deepEqual(await changedSince(movedTip), ["feature.txt"]);
    assert.equal(await show("feature:feature.txt"), movedFile.replace(LINES[19]!, "edited"));
  });
}

test("publishes local commits on top of the branch tip", async () => {
  await stage(sandbox, "feature.txt", "first\n");
  await signedCommit("first");
  const tip = await rev(remote, "feature");
  await commitFile(sandbox, "local.txt", "committed locally\n");
  await stage(sandbox, "feature.txt", "second\n");

  await signedCommit("second");
  assert.equal(await rev(remote, "feature^"), tip);
  assert.deepEqual(await changedSince(tip), ["feature.txt", "local.txt"]);
});

test("starts a new branch at the newest pushed commit and publishes local commits", async () => {
  const clonedMain = await rev(sandbox, "HEAD");
  await commitFile(sandbox, "local.txt", "committed locally\n");
  await stage(sandbox, "feature.txt", "first\n");

  await signedCommit("first");
  assert.equal(await rev(remote, "feature^"), clonedMain);
  assert.deepEqual(await changedSince(clonedMain), ["feature.txt", "local.txt"]);
});

async function assertRefused(message: string, patterns: RegExp[]) {
  const before = await readFile(log, "utf8");
  await assert.rejects(signedCommit(message), (error: unknown) => {
    const { code, stderr } = error as { code: number; stderr: string };
    assert.equal(code, 1);
    for (const pattern of patterns) assert.match(stderr, pattern);
    return true;
  });
  assert.doesNotMatch((await readFile(log, "utf8")).slice(before.length), /^POST /mu);
}

async function checkoutRemoteFeature(cwd: string) {
  await git(cwd, "fetch", "--quiet", "origin", "feature");
  await git(cwd, "checkout", "--quiet", "-B", "feature", "FETCH_HEAD");
}

async function signedCommit(message: string, env: Record<string, string> = {}) {
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
        ...env,
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
  return (
    await execFileAsync("git", ["--git-dir", remote, "show", object], { maxBuffer: Infinity })
  ).stdout;
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
  return changedSince(await git(dir, "--git-dir", remote, "merge-base", "main", branch));
}

async function changedSince(base: string) {
  return (await git(dir, "--git-dir", remote, "diff", "--name-only", base, "feature")).split("\n");
}
