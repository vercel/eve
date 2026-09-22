export const BENCHMARK_HARNESSES = [
  "eve-code",
  "codex",
  "opencode",
  "claude-code",
  "pi",
  "hermes",
  "oracle",
];

/** Harnesses compared on every automatic run; eve-code against opencode and pi. */
export const DEFAULT_HARNESSES = ["eve-code", "opencode", "pi"];

function parseHarnesses(value) {
  const harnesses = [...new Set(value.split(/[ ,]+/u).filter(Boolean))];
  const unknown = harnesses.filter((harness) => !BENCHMARK_HARNESSES.includes(harness));
  if (!harnesses.length || unknown.length) {
    throw new Error(`Supported benchmark harnesses: ${BENCHMARK_HARNESSES.join(", ")}.`);
  }
  return harnesses;
}

function request(harnesses, sha, pr) {
  return { harness: harnesses.join(","), slug: harnesses.join("+"), sha, pr };
}

export async function resolveBenchmarkRequest({ github, context }) {
  const { payload, eventName, repo, sha } = context;
  let harnesses = DEFAULT_HARNESSES;
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
    const command = /^\/benchmark(?: +([a-z-]+(?:[ ,]+[a-z-]+)*))?$/u.exec(body);
    if (!command) throw new Error("Use /benchmark or /benchmark <harness>[,<harness>...].");
    if (command[1]) harnesses = parseHarnesses(command[1]);
    number = payload.issue.number;
  } else if (eventName === "workflow_dispatch") {
    if (payload.inputs?.harness) harnesses = parseHarnesses(payload.inputs.harness);
  } else if (eventName !== "pull_request" && eventName !== "push") {
    return null;
  }

  if (!number) {
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Benchmark source must be an exact commit.");
    return request(harnesses, sha, "");
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
  return request(harnesses, pull.head.sha, String(number));
}
