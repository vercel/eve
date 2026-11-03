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
const headers = {
  Accept: "application/vnd.github+json",
  Authorization: "Bearer " + process.env.GH_TOKEN,
  "Content-Type": "application/json",
  "X-GitHub-Api-Version": "2022-11-28",
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

async function main() {
  ensureNoUnstagedTrackedChanges();
  const changes = stagedChanges();
  if (changes.additions.length === 0 && changes.deletions.length === 0) {
    throw new Error("no staged changes; stage files with git add before running gh-signed-commit");
  }
  const localHead = git("rev-parse", "HEAD").toString().trim();
  const head = await branchHead(options.branch);
  if (head === null) {
    // Like git push, start the branch at local HEAD, not at a newer base tip.
    if (!(await commitExists(localHead))) {
      throw new Error("local HEAD " + localHead + " does not exist on GitHub. " + restage(pushedBase()));
    }
    await request("POST", "/repos/" + owner + "/" + repo + "/git/refs", {
      ref: "refs/heads/" + options.branch,
      sha: localHead,
    });
  } else if (head !== localHead) {
    // The commit is the remote tip plus the staged diff against local HEAD, so
    // every remote change missing locally would be committed reversed.
    throw new Error(
      "local HEAD " + localHead + " is not the tip of " + options.branch + " (" + head + "); committing would revert the remote changes missing locally. " +
        (isAncestor(head, localHead)
          ? restage(head)
          : "Run git pull --ff-only " + remote + " " + options.branch + " through the authenticated gh tool, then run gh-signed-commit again. " +
            "If the pull is refused, commit the staged changes locally, run git pull --rebase " + remote + " " + options.branch + " through the authenticated gh tool, run git reset --soft FETCH_HEAD, then run gh-signed-commit again."),
    );
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
          expectedHeadOid: head ?? localHead,
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
  // Move to the commit just made, which has the index as its tree. The branch
  // tip may already include someone else's later push.
  git("fetch", remote, options.branch);
  git("reset", "--soft", oid);
  process.stdout.write(oid + "\n");
}

function restage(base) {
  return "gh-signed-commit publishes only staged changes, never local commits: " +
    (base ? "run git reset --soft " + base : "run git reset --soft with the newest commit of yours that exists on GitHub") +
    " to stage your local commits, then run gh-signed-commit again.";
}

// The pushed commit the local commits start from, when there is exactly one.
function pushedBase() {
  const boundary = git("rev-list", "--boundary", "HEAD", "--not", "--remotes").toString().split("\n").filter((line) => line.startsWith("-"));
  return boundary.length === 1 ? boundary[0].slice(1) : null;
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

function stagedChanges() {
  const output = git("diff", "--cached", "--no-renames", "--raw", "-z", "HEAD");
  const tokens = output.toString().split("\0").filter(Boolean);
  const additions = [];
  const deletions = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const [oldMode, newMode, , , status] = tokens[index].slice(1).split(" ");
    const path = tokens[index + 1];
    if (!status || !path) throw new Error("unexpected staged diff output");
    if (status === "A" || status === "M" || status === "T") {
      // FileAddition carries no mode, so it cannot express every index entry safely.
      if (newMode !== "100644" || (oldMode !== "000000" && oldMode !== "100644")) {
        throw new Error("cannot safely publish " + JSON.stringify(path) + " (mode " + oldMode + " -> " + newMode + "); gh-signed-commit only adds or updates non-executable regular files. Use native git commit -S with a configured signing key and git push for executable files, symlinks, submodules, or mode changes. Your staged changes are preserved.");
      }
      additions.push({ path, contents: git("show", ":0:" + path).toString("base64") });
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

async function commitExists(sha) {
  const response = await fetch(api + "/repos/" + owner + "/" + repo + "/git/commits/" + sha, { headers });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error("GitHub commit lookup failed: " + response.status);
  return true;
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
