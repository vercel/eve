export const GH_SIGNED_COMMIT_VERSION = "4";

export const GH_SIGNED_COMMIT_SOURCE = String.raw`#!/usr/bin/env node
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const options = { body: undefined };
for (let i = 0; i < args.length; i += 1) {
  const value = args[i];
  if (value === "--repo") options.repo = args[++i];
  else if (value === "--branch") options.branch = args[++i];
  else if (value === "--base") {
    i += 1;
    process.stderr.write("gh-signed-commit: --base is ignored; new branches start at local HEAD\n");
  }
  else if (value === "-m") options.message = args[++i];
  else if (value === "-b") options.body = args[++i];
  else fail("unknown argument: " + value);
}
if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(options.repo || "")) fail("--repo owner/name is required");
if (!options.branch) fail("--branch is required");
if (!options.message) fail("-m headline is required");
if (!process.env.GH_TOKEN) fail('GH_TOKEN is not set; invoke the configured authenticated gh tool with command "gh-signed-commit --repo owner/name --branch branch -m headline", repository "owner/name", a description of the intended commit, and workingDirectory set to the repository. Use the same repository for --repo and repository; the tool supplies the credential lease.');

const [owner, repo] = options.repo.split("/");
const api = "https://api.github.com";
const remote = "https://github.com/" + options.repo;
const ANCESTOR_LIMIT = 100;
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: "Bearer " + process.env.GH_TOKEN,
  "Content-Type": "application/json",
  "X-GitHub-Api-Version": "2022-11-28",
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

async function main() {
  ensureNoUnstagedTrackedChanges();
  // The commit's parent: the branch tip, or for a new branch the newest commit of
  // HEAD that the repository has. Local commits after it are published with the index.
  const head = await branchHead(options.branch);
  const base = head ?? (await publishedAncestor());
  // The commit's tree is the index, so a base the checkout lacks would be reverted.
  if (!isAncestor(base, "HEAD")) {
    throw new Error(
      options.branch + " is at " + base + ", which this checkout lacks; committing would revert it. " +
        "Commit your changes locally, run git pull --rebase " + remote + " " + options.branch + " through the authenticated gh tool, then run gh-signed-commit again.",
    );
  }
  const changes = changesSince(base);
  if (changes.additions.length === 0 && changes.deletions.length === 0) {
    throw new Error("nothing to commit; stage files with git add before running gh-signed-commit");
  }
  if (head === null) {
    await request("POST", "/repos/" + owner + "/" + repo + "/git/refs", { ref: "refs/heads/" + options.branch, sha: base });
  }

  const message = { headline: options.message };
  if (options.body) message.body = options.body;
  const data = await graphql(
    "mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid url } } }",
    {
      input: {
        branch: { repositoryNameWithOwner: options.repo, branchName: options.branch },
        expectedHeadOid: base,
        message,
        fileChanges: changes,
      },
    },
  );
  const oid = data?.createCommitOnBranch?.commit?.oid;
  if (!oid) throw new Error("GitHub commit returned no oid");
  // Move to the commit just made, whose tree is the index. The branch tip may
  // already include someone else's later push.
  git("fetch", remote, options.branch);
  git("reset", "--soft", oid);
  process.stdout.write(oid + "\n");
}

// Asks GitHub, not remote-tracking refs, which can be missing or stale.
async function publishedAncestor() {
  const candidates = git("rev-list", "--first-parent", "--max-count=" + ANCESTOR_LIMIT, "HEAD").toString().split("\n").filter(Boolean);
  const fields = candidates.map((oid, index) => "c" + index + ': object(oid: "' + oid + '") { oid }').join(" ");
  const data = await graphql("query { repository(owner: " + JSON.stringify(owner) + ", name: " + JSON.stringify(repo) + ") { " + fields + " } }");
  const base = candidates.find((_, index) => data.repository["c" + index]);
  if (!base) throw new Error("none of the last " + ANCESTOR_LIMIT + " commits of HEAD exist in " + options.repo + "; check out a commit from it before running gh-signed-commit");
  return base;
}

async function graphql(query, variables) {
  const response = await fetch(api + "/graphql", { method: "POST", headers, body: JSON.stringify({ query, variables }) });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) {
    throw new Error("GitHub GraphQL request failed: " + (payload.errors?.map((item) => item.message).join("; ") || response.status));
  }
  return payload.data;
}

function isAncestor(ancestor, commit) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, commit], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ensureNoUnstagedTrackedChanges() {
  try {
    execFileSync("git", ["diff", "--quiet"], { stdio: "ignore" });
  } catch (error) {
    if (error && error.status === 1) {
      throw new Error("unstaged tracked changes would be unsafe; preserve them and use a clean worktree, or stage only changes authorized for this commit. Do not stash, revert, or overwrite unrelated user changes without explicit authorization.");
    }
    throw error;
  }
}

function changesSince(base) {
  const output = git("diff", "--cached", "--no-renames", "--raw", "-z", base);
  const tokens = output.toString().split("\0").filter(Boolean);
  const additions = [];
  const deletions = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const [oldMode, newMode, , , status] = tokens[index].slice(1).split(" ");
    const path = tokens[index + 1];
    if (!status || !path) throw new Error("unexpected diff output");
    if (status === "A" || status === "M" || status === "T") {
      // FileAddition carries no mode, so it cannot express every index entry safely.
      if (newMode !== "100644" || (oldMode !== "000000" && oldMode !== "100644")) {
        throw new Error("cannot safely publish " + JSON.stringify(path) + " (mode " + oldMode + " -> " + newMode + "); gh-signed-commit only adds or updates non-executable regular files. Use native git commit -S with a configured signing key and git push for executable files, symlinks, submodules, or mode changes. Your staged changes are preserved.");
      }
      additions.push({ path, contents: git("show", ":0:" + path).toString("base64") });
    } else if (status === "D") deletions.push({ path });
    else if (status === "U") throw new Error("unmerged path: " + path);
    else throw new Error("unsupported status " + status + " for " + path);
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
  return execFileSync("git", values, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: Infinity });
}

function fail(message) {
  process.stderr.write("gh-signed-commit: " + message + "\n");
  process.exit(1);
}
`;
