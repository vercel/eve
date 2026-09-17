export const GH_SIGNED_COMMIT_VERSION = "1";

export const GH_SIGNED_COMMIT_SOURCE = String.raw`#!/usr/bin/env node
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const options = { base: undefined, body: undefined };
for (let i = 0; i < args.length; i += 1) {
  const value = args[i];
  if (value === "--repo") options.repo = args[++i];
  else if (value === "--branch") options.branch = args[++i];
  else if (value === "--base") options.base = args[++i];
  else if (value === "-m") options.message = args[++i];
  else if (value === "-b") options.body = args[++i];
  else fail("unknown argument: " + value);
}
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(options.repo || "")) fail("--repo owner/name is required");
if (!options.branch) fail("--branch is required");
if (!options.message) fail("-m headline is required");
if (!process.env.GH_TOKEN) fail("GH_TOKEN is not set; run the GitHub login tool first");

const [owner, repo] = options.repo.split("/");
const api = "https://api.github.com";
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: "Bearer " + process.env.GH_TOKEN,
  "Content-Type": "application/json",
  "X-GitHub-Api-Version": "2022-11-28",
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

async function main() {
  ensureNoUnstagedTrackedChanges();
  let head = await branchHead(options.branch);
  if (head === null) {
    const base = options.base || (await request("GET", "/repos/" + owner + "/" + repo)).default_branch;
    const baseHead = await branchHead(base);
    if (baseHead === null) throw new Error("base ref not found: " + base);
    await request("POST", "/repos/" + owner + "/" + repo + "/git/refs", {
      ref: "refs/heads/" + options.branch,
      sha: baseHead,
    });
    head = baseHead;
  }

  const changes = stagedChanges();
  if (changes.additions.length === 0 && changes.deletions.length === 0) {
    throw new Error("no staged changes; stage files with git add before running gh-signed-commit");
  }
  const query = "mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }";
  const message = { headline: options.message };
  if (options.body) message.body = options.body;
  const response = await fetch(api + "/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({
      query,
      variables: {
        input: {
          branch: { repositoryNameWithOwner: options.repo, branchName: options.branch },
          expectedHeadOid: head,
          message,
          fileChanges: changes,
        },
      },
    }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error("GitHub commit failed: " + (payload.errors?.map((item) => item.message).join("; ") || response.status));
  }
  const oid = payload.data?.createCommitOnBranch?.commit?.oid;
  if (!oid) throw new Error("GitHub commit returned no oid");
  git("fetch", "origin", options.branch);
  git("reset", "--soft", "FETCH_HEAD");
  process.stdout.write(oid + "\n");
}

function ensureNoUnstagedTrackedChanges() {
  try {
    execFileSync("git", ["diff", "--quiet"], { stdio: "ignore" });
  } catch (error) {
    if (error && error.status === 1) {
      throw new Error("unstaged tracked changes would be unsafe; stage them, stash or revert unrelated changes, or use a clean worktree");
    }
    throw error;
  }
}

function stagedChanges() {
  const output = git("diff", "--cached", "--no-renames", "--name-status", "-z", "HEAD");
  const tokens = output.toString().split("\0").filter(Boolean);
  const additions = [];
  const deletions = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index]?.[0];
    const path = tokens[index + 1];
    if (!status || !path) throw new Error("unexpected staged diff output");
    if (status === "A" || status === "M" || status === "T") {
      additions.push({ path, contents: git("show", ":" + path).toString("base64") });
    } else if (status === "D") deletions.push({ path });
    else if (status === "U") throw new Error("unmerged path: " + path);
    else throw new Error("unsupported staged status " + status + " for " + path);
  }
  return { additions, deletions };
}

async function branchHead(branch) {
  const response = await fetch(api + "/repos/" + owner + "/" + repo + "/git/ref/" + encodeURIComponent("heads/" + branch), { headers });
  if (response.status === 404) return null;
  const payload = await response.json();
  if (!response.ok) throw new Error("GitHub ref lookup failed: " + response.status);
  return payload.object.sha;
}

async function request(method, path, body) {
  const response = await fetch(api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error("GitHub " + method + " " + path + " failed: " + response.status);
  return payload;
}

function git(...values) {
  return execFileSync("git", values, { stdio: ["ignore", "pipe", "inherit"] });
}

function fail(message) {
  process.stderr.write("gh-signed-commit: " + message + "\n");
  process.exit(1);
}
`;
