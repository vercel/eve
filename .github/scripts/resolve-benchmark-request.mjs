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

/**
 * eve-bench datasets a benchmark can run, with the settings each was calibrated for.
 * swe-lean needs five attempts to separate a 10-15% token change from trial noise.
 * deepswe-lean resolves almost nothing at low reasoning, and its 20-minute trials
 * make three attempts the most that fits one job.
 */
export const BENCHMARK_DATASETS = {
  "swe-lean": { reasoning: "low", attempts: "5" },
  "deepswe-lean": { reasoning: "high", attempts: "3" },
};

/** The dataset of every automatic run and of a request that names none. */
export const DEFAULT_DATASET = "deepswe-lean";

function parseDataset(value) {
  if (!Object.hasOwn(BENCHMARK_DATASETS, value)) {
    throw new Error(`Supported benchmark datasets: ${Object.keys(BENCHMARK_DATASETS).join(", ")}.`);
  }
  return value;
}

function splitNames(value) {
  return value.split(/[ ,]+/u).filter(Boolean);
}

function parseHarnesses(names) {
  const harnesses = [...new Set(names)];
  const unknown = harnesses.filter((harness) => !BENCHMARK_HARNESSES.includes(harness));
  if (!harnesses.length || unknown.length) {
    throw new Error(`Supported benchmark harnesses: ${BENCHMARK_HARNESSES.join(", ")}.`);
  }
  return harnesses;
}

/** `[<dataset>] [<harness>...]`, in any order; a dataset or the harness list may be omitted. */
function parseSelection(value) {
  const names = splitNames(value);
  const datasets = names.filter((name) => Object.hasOwn(BENCHMARK_DATASETS, name));
  if (datasets.length > 1) throw new Error("Name at most one benchmark dataset.");
  const harnesses = names.filter((name) => !datasets.includes(name));
  return {
    dataset: datasets[0] ?? DEFAULT_DATASET,
    harnesses: harnesses.length ? parseHarnesses(harnesses) : DEFAULT_HARNESSES,
  };
}

function request({ dataset, harnesses }, sha, pr) {
  return {
    harness: harnesses.join(","),
    slug: harnesses.join("+"),
    dataset,
    ...BENCHMARK_DATASETS[dataset],
    sha,
    pr,
  };
}

export async function resolveBenchmarkRequest({ github, context }) {
  const { payload, eventName, repo, sha } = context;
  let selection = { dataset: DEFAULT_DATASET, harnesses: DEFAULT_HARNESSES };
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
    if (!command) throw new Error("Use /benchmark [<dataset>] [<harness>[,<harness>...]].");
    if (command[1]) selection = parseSelection(command[1]);
    number = payload.issue.number;
  } else if (eventName === "workflow_dispatch") {
    selection = {
      dataset: parseDataset(payload.inputs?.dataset || DEFAULT_DATASET),
      harnesses: payload.inputs?.harness
        ? parseHarnesses(splitNames(payload.inputs.harness))
        : DEFAULT_HARNESSES,
    };
  } else if (eventName !== "pull_request" && eventName !== "push") {
    return null;
  }

  if (!number) {
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Benchmark source must be an exact commit.");
    return request(selection, sha, "");
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
  return request(selection, pull.head.sha, String(number));
}
