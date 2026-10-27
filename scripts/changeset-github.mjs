import { execFileSync } from "node:child_process";

export async function pullRequestFor(commit, id) {
  if (!commit)
    throw new Error(`Changeset ${id} has no commit; commit it before running version-packages.`);
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) throw new Error("Set GITHUB_TOKEN or GH_TOKEN to look up changeset pull requests.");
  const response = await fetch(`https://api.github.com/repos/vercel/eve/commits/${commit}/pulls`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `GitHub pull request lookup for changeset ${id} failed: HTTP ${response.status}.`,
    );
  const pulls = (await response.json()).filter(
    (pull) => pull.merged_at && pull.base?.ref === "main",
  );
  if (pulls.length !== 1)
    throw new Error(
      `Changeset ${id}: expected one merged pull request for commit ${commit}, found ${pulls.length}.`,
    );
  const message = execFileSync("git", ["show", "-s", "--format=%B", commit], { encoding: "utf8" });
  const coauthors = [
    ...message.matchAll(/^Co-authored-by:.*<\d+\+([^@>]+)@users\.noreply\.github\.com>/gimu),
  ].map((match) => match[1]);
  return { number: pulls[0].number, author: pulls[0].user?.login, coauthors };
}
