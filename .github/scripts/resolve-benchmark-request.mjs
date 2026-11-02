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
 * make three attempts the most that fits one job. eve-bench compares and publishes
 * only whole-dataset results with matching attempts, so the tasks cannot be split
 * across jobs to add attempts.
 */
export const BENCHMARK_DATASETS = {
  "swe-lean": { reasoning: "low", attempts: "5" },
  "deepswe-lean": { reasoning: "high", attempts: "3" },
};

/** The dataset of every automatic run and of a request that names none. */
export const DEFAULT_DATASET = "swe-lean";

/** The dataset of the weekly run on main, which keeps its baselines fresh. */
export const SCHEDULED_DATASET = "deepswe-lean";

/**
 * Model families a benchmark can run; the workflow maps each to a model ID. The first is
 * the default. eve-bench stores results per model, so families are never compared with
 * each other. Main covers every family; a PR runs one, because eve-bench keys its PR
 * comment by harness and dataset only, and two families would overwrite each other.
 */
export const BENCHMARK_MODEL_FAMILIES = ["anthropic", "openai"];

export const DEFAULT_MODEL_FAMILY = BENCHMARK_MODEL_FAMILIES[0];

function parseDataset(value) {
  if (!Object.hasOwn(BENCHMARK_DATASETS, value)) {
    throw new Error(`Supported benchmark datasets: ${Object.keys(BENCHMARK_DATASETS).join(", ")}.`);
  }
  return value;
}

function parseFamily(value) {
  if (!BENCHMARK_MODEL_FAMILIES.includes(value)) {
    throw new Error(`Supported benchmark models: ${BENCHMARK_MODEL_FAMILIES.join(", ")}.`);
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

/** `[<dataset>] [model=<family>] [<harness>...]`, in any order; each part may be omitted. */
function parseSelection(value) {
  const names = splitNames(value);
  const datasets = names.filter((name) => Object.hasOwn(BENCHMARK_DATASETS, name));
  if (datasets.length > 1) throw new Error("Name at most one benchmark dataset.");
  const models = names.filter((name) => name.startsWith("model="));
  if (models.length > 1) throw new Error("Name at most one benchmark model.");
  const harnesses = names.filter((name) => !datasets.includes(name) && !models.includes(name));
  return {
    dataset: datasets[0] ?? DEFAULT_DATASET,
    harnesses: harnesses.length ? parseHarnesses(harnesses) : DEFAULT_HARNESSES,
    families: [
      models.length ? parseFamily(models[0].slice("model=".length)) : DEFAULT_MODEL_FAMILY,
    ],
  };
}

function request({ dataset, harnesses, families }, models, sha, pr) {
  return {
    harness: harnesses.join(","),
    slug: harnesses.join("+"),
    dataset,
    ...BENCHMARK_DATASETS[dataset],
    models: families.map((family) => {
      const model = models?.[family];
      if (typeof model !== "string" || !model) throw new Error(`No model is set for ${family}.`);
      return { family, model };
    }),
    sha,
    pr,
  };
}

/**
 * Resolves the triggering event into benchmark inputs, or null when it must not run.
 * `models` maps every family in BENCHMARK_MODEL_FAMILIES to a model ID.
 */
export async function resolveBenchmarkRequest({ github, context, models }) {
  const { payload, eventName, repo, sha } = context;
  let selection = {
    dataset: DEFAULT_DATASET,
    harnesses: DEFAULT_HARNESSES,
    families: BENCHMARK_MODEL_FAMILIES,
  };
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
    const command = /^\/benchmark(?: +([a-z=-]+(?:[ ,]+[a-z=-]+)*))?$/u.exec(body);
    if (!command) {
      throw new Error("Use /benchmark [<dataset>] [model=<family>] [<harness>[,<harness>...]].");
    }
    selection = command[1]
      ? parseSelection(command[1])
      : { ...selection, families: [DEFAULT_MODEL_FAMILY] };
    number = payload.issue.number;
  } else if (eventName === "pull_request") {
    selection.families = [DEFAULT_MODEL_FAMILY];
  } else if (eventName === "workflow_dispatch") {
    const model = payload.inputs?.model || "all";
    selection = {
      dataset: parseDataset(payload.inputs?.dataset || DEFAULT_DATASET),
      harnesses: payload.inputs?.harness
        ? parseHarnesses(splitNames(payload.inputs.harness))
        : DEFAULT_HARNESSES,
      families: model === "all" ? BENCHMARK_MODEL_FAMILIES : [parseFamily(model)],
    };
  } else if (eventName === "schedule") {
    selection.dataset = SCHEDULED_DATASET;
  } else if (eventName !== "push") {
    return null;
  }

  if (!number) {
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Benchmark source must be an exact commit.");
    return request(selection, models, sha, "");
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
  return request(selection, models, pull.head.sha, String(number));
}
