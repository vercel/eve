import { type Config, digest } from "./config.js";
import { checkout, openIndependent, repositoryPath } from "./hosted.js";
import { captureFiles } from "./publish.js";
import { GitHub } from "./providers.js";
import type { Candidate, Experiment } from "./types.js";

export async function createRevert(c: Config, experiment: Experiment): Promise<Candidate> {
  const git = new GitHub(c),
    branch = `eve-evolve/revert-${experiment.id}`;
  const existing = await git.findPr(branch);
  const main = await git.main(),
    bad = experiment.release?.sha;
  if (!bad || !/^[a-f0-9]{40}$/.test(bad))
    throw new Error("Missing offending release SHA for revert");
  if (main !== bad)
    throw new Error(
      "Main advanced after the regression; reconcile the revert against those changes before publishing",
    );
  const sandbox = await openIndependent(c);
  try {
    await checkout(c, sandbox, main);

    const reverted = await sandbox.run({
      command: `git revert --no-commit ${bad}`,
      workingDirectory: repositoryPath,
    });
    if (reverted.exitCode !== 0)
      throw new Error(
        "Automatic revert conflicts; production stays rolled back and main is unchanged",
      );
    const names = await sandbox.run({
      command: "git diff --cached --name-only -z",
      workingDirectory: repositoryPath,
    });
    if (names.exitCode !== 0) throw new Error("Could not inspect reverted paths");
    const paths = names.stdout.split("\0").filter(Boolean);
    const fileChanges = await captureFiles(
      c,
      { getSandbox: async () => sandbox },
      git,
      main,
      paths,
    );
    const operation = digest(["revert", experiment.id, main, fileChanges]);
    let head = await git.branch(branch);
    if (!head) {
      await git.api(`/repos/${git.repo}/git/refs`, "POST", {
        ref: `refs/heads/${branch}`,
        sha: main,
      });
      head = main;
    }
    if (head === main) {
      const result = await git.graphql(
        `mutation($input:CreateCommitOnBranchInput!){createCommitOnBranch(input:$input){commit{oid}}}`,
        {
          input: {
            branch: { repositoryNameWithOwner: git.repo, branchName: branch },
            expectedHeadOid: main,
            message: {
              headline: `Revert regression ${bad.slice(0, 7)}`,
              body: `Eve-Evolution-Operation: ${operation}`,
            },
            fileChanges,
          },
        },
      );
      head = result.createCommitOnBranch?.commit?.oid;
    }
    if (!head || !/^[a-f0-9]{40}$/.test(head))
      throw new Error("Revert publication unconfirmed; reconcile the deterministic branch");
    const commit = await git.api(`/repos/${git.repo}/commits/${head}`);
    const released = await git.api(`/repos/${git.repo}/commits/${bad}`);
    if (released.parents?.length !== 1)
      throw new Error("Release parent is ambiguous; reconcile the reverse tree before publishing");
    const parent = await git.api(`/repos/${git.repo}/commits/${released.parents[0].sha}`);
    if (
      !commit.commit?.verification?.verified ||
      !String(commit.commit.message)
        .split("\n")
        .includes(`Eve-Evolution-Operation: ${operation}`) ||
      commit.parents?.length !== 1 ||
      commit.parents[0].sha !== main ||
      !parent.commit?.tree?.sha ||
      commit.commit?.tree?.sha !== parent.commit.tree.sha
    )
      throw new Error("Revert signature or operation identity is not verified");
    let pr = existing;
    try {
      if (!pr)
        pr = await git.api(`/repos/${git.repo}/pulls`, "POST", {
          head: branch,
          base: c.repository.branch,
          draft: true,
          title: `Revert release regression ${bad.slice(0, 7)}`,
          body: `Production was restored to its recorded known-good deployment. This signed revert reconciles source through the same tests, reviews, required checks and verified eve deployment. Experiment: ${experiment.id}.`,
        });
    } catch {
      pr = await git.findPr(branch);
      if (!pr) throw new Error("Revert PR outcome unconfirmed; reconcile before retrying");
    }
    if (
      pr.head?.sha !== head ||
      pr.head?.ref !== branch ||
      pr.head?.repo?.full_name?.toLowerCase() !== git.repo.toLowerCase() ||
      pr.base?.ref !== c.repository.branch ||
      pr.base?.sha !== main
    )
      throw new Error("Recovery PR does not match the verified reverse tree and target branch");
    return {
      branch,
      head,
      base: main,
      pr: pr.number,
      url: pr.html_url,
      changedPaths: paths,
      addressedThreads: [],
      publishedAt: Date.now(),
    };
  } finally {
    await sandbox.delete();
  }
}
