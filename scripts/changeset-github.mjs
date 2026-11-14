import { execFileSync } from "node:child_process";

// Changesets asks for every release line at once, and a stable release collects
// every prerelease's changesets. A burst of hundreds of lookups trips GitHub's
// secondary rate limit (HTTP 403), so only a few run at a time.
const maxLookups = 4;
let activeLookups = 0;
const waitingLookups = [];

async function withLookupSlot(task) {
  if (activeLookups < maxLookups) activeLookups++;
  else await new Promise((resolve) => waitingLookups.push(resolve));
  try {
    return await task();
  } finally {
    const next = waitingLookups.shift();
    if (next) next();
    else activeLookups--;
  }
}

// A release job re-runs every lookup on each push while the release PR is open,
// so a rate-limited lookup waits as GitHub asks, capped, before it fails.
const maxAttempts = 4;

function retryDelayMs(response, attempt) {
  const retryAfter = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const delay =
    retryAfter > 0
      ? retryAfter * 1000
      : response.headers.get("x-ratelimit-remaining") === "0" && reset > 0
        ? reset * 1000 - Date.now()
        : 2 ** attempt * 1000;
  return Math.min(Math.max(delay, 1000), 60_000);
}

export async function pullRequestFor(commit, id) {
  if (!commit)
    throw new Error(`Changeset ${id} has no commit; commit it before running version-packages.`);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("Set GITHUB_TOKEN or GH_TOKEN to look up changeset pull requests.");
  const body = await withLookupSlot(async () => {
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(
        `https://api.github.com/repos/vercel/eve/commits/${commit}/pulls`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (response.ok) return response.json();
      const rateLimited = response.status === 403 || response.status === 429;
      if (!rateLimited || attempt === maxAttempts)
        throw new Error(
          `GitHub pull request lookup for changeset ${id} failed: HTTP ${response.status}.`,
        );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(response, attempt)));
    }
  });
  const merged = body.filter((pull) => pull.merged_at);
  const matches = merged.filter((pull) => pull.merge_commit_sha === commit);
  const pulls = matches.length ? matches : merged;
  if (pulls.length !== 1)
    throw new Error(
      `Changeset ${id}: expected one merged pull request for commit ${commit}, found ${pulls.length}.`,
    );
  const message = execFileSync("git", ["show", "-s", "--format=%B", commit], { encoding: "utf8" });
  return { number: pulls[0].number, subject: message.split(/\r?\n/u)[0] };
}
