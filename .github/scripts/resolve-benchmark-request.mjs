export const BENCHMARK_HARNESSES = [
  "eve-code",
  "codex",
  "opencode",
  "claude-code",
  "pi",
  "hermes",
  "oracle",
];

export async function resolveBenchmarkRequest({ github, context }) {
  const { payload, eventName, repo, sha } = context;
  let harness = "eve-code";
  let number = payload.pull_request?.number;

  if (eventName === "issue_comment") {
    if (payload.action !== "created" || !payload.issue?.pull_request) return null;
    const body = payload.comment?.body?.trim() ?? "";
    if (!body.startsWith("/benchmark") || payload.comment?.user?.type !== "User") return null;
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({
      ...repo,
      username: payload.comment.user.login,
    });
    if (!["admin", "maintain", "write"].includes(data.permission)) return null;
    const command = /^\/benchmark(?:\s+([a-z-]+))?$/u.exec(body);
    if (!command) throw new Error("Use /benchmark or /benchmark <harness>.");
    harness = command[1] ?? harness;
    number = payload.issue.number;
  } else if (eventName === "workflow_dispatch") {
    harness = payload.inputs?.harness || harness;
  } else if (eventName !== "pull_request") {
    return null;
  }

  if (!BENCHMARK_HARNESSES.includes(harness)) {
    throw new Error(`Supported benchmark harnesses: ${BENCHMARK_HARNESSES.join(", ")}.`);
  }
  if (!number) {
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Benchmark source must be an exact commit.");
    return { harness, sha, pr: "" };
  }

  const { data: pull } = await github.rest.pulls.get({ ...repo, pull_number: number });
  const repository = `${repo.owner}/${repo.repo}`;
  if (
    pull.state !== "open" ||
    pull.head.repo?.fork !== false ||
    pull.head.repo.full_name !== repository ||
    pull.base.repo.full_name !== repository
  )
    return null;
  if (eventName === "pull_request" && pull.head.sha !== payload.pull_request.head.sha) return null;
  if (!/^[a-f0-9]{40}$/u.test(pull.head.sha)) throw new Error("PR head must be an exact commit.");
  return { harness, sha: pull.head.sha, pr: String(number) };
}
