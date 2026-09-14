export async function resolvePublicationTarget(github, context) {
  const run = context.payload.workflow_run;
  if (run?.conclusion !== "success") {
    throw new Error("Package publication requires a successful package build.");
  }

  if (run.event === "push") return resolveMainTarget(github, context.repo, run);
  if (run.event === "pull_request") return resolvePullRequestTarget(github, context.repo, run);
  throw new Error(`Unsupported package build event: ${String(run.event)}.`);
}

async function resolveMainTarget(github, repo, run) {
  if (run.head_branch !== "main") throw new Error("Only main pushes may publish a main package.");

  const { data: branch } = await github.rest.repos.getBranch({ ...repo, branch: "main" });
  if (branch.commit.sha !== run.head_sha) {
    throw new Error(
      `Refusing to publish stale main build ${run.head_sha}; main is ${branch.commit.sha}.`,
    );
  }
  return { runId: String(run.id), sha: run.head_sha, ref: "main" };
}

async function resolvePullRequestTarget(github, repo, run) {
  const headRepository = run.head_repository?.full_name;
  if (typeof headRepository !== "string" || headRepository.length === 0) {
    throw new Error("Package build is missing its head repository.");
  }

  const [headOwner] = headRepository.split("/");
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...repo,
    base: "main",
    head: `${headOwner}:${run.head_branch}`,
    state: "open",
    per_page: 100,
  });
  const matches = pulls.filter(
    (pull) =>
      pull.state === "open" &&
      pull.base.ref === "main" &&
      pull.head.sha === run.head_sha &&
      pull.head.ref === run.head_branch &&
      pull.head.repo?.full_name === headRepository,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one open pull request for package build ${run.id} at ${run.head_sha}; found ${matches.length}.`,
    );
  }

  return { runId: String(run.id), sha: run.head_sha, ref: String(matches[0].number) };
}
