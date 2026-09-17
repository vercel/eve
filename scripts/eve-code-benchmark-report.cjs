const { constants } = require("node:fs");
const { lstat, open, opendir } = require("node:fs/promises");
const { join } = require("node:path");
const config = require("./eve-code-benchmark-config.json");

const MARKER = "<!-- eve-code-benchmark -->";
const MAX_BYTES = 1024 * 1024;
const MAX_COMMENT_PAGES = 10;
const FILE_KEYS =
  "schemaVersion headSha runnerRevision baselineRevision model arm shard shards dataset trials completed";
const TRIAL_KEYS = "task attempt reward durationMs costUsd error";

function check(condition, message) {
  if (!condition) throw new Error(`Invalid benchmark report: ${message}`);
}

function keys(value, expected) {
  const names = expected.split(" ");
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === names.length &&
    names.every((name) => Object.hasOwn(value, name))
  );
}

function nonnegative(value) {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function validate(report, arm, shard, headSha, model) {
  check(keys(report, FILE_KEYS), "file schema");
  check(
    report.schemaVersion === 1 &&
      report.headSha === headSha &&
      report.model === model &&
      report.runnerRevision === config.runnerRevision &&
      report.baselineRevision === config.baselineRevision,
    "provenance/model/pins",
  );
  check(
    report.arm === arm && report.shard === shard && report.shards === config.shards,
    "arm/shard identity",
  );
  check(
    keys(report.dataset, "name version commit") &&
      ["name", "version", "commit"].every((key) => report.dataset[key] === config.dataset[key]),
    "dataset pin",
  );
  const assigned = new Set(
    config.dataset.tasks.filter((_, index) => index % config.shards === shard),
  );
  check(
    typeof report.completed === "boolean" &&
      Array.isArray(report.trials) &&
      report.trials.length <= assigned.size,
    "completion/trial count",
  );
  const seen = new Set();
  for (const trial of report.trials) {
    check(keys(trial, TRIAL_KEYS), "trial schema");
    check(
      assigned.has(trial.task) && trial.attempt === 1 && !seen.has(trial.task),
      "task/attempt/duplicate",
    );
    seen.add(trial.task);
    check(
      (trial.reward === null || (nonnegative(trial.reward) && trial.reward <= 1)) &&
        nonnegative(trial.durationMs) &&
        (trial.costUsd === null || nonnegative(trial.costUsd)) &&
        typeof trial.error === "boolean",
      "trial values",
    );
  }
  return report;
}

async function readBounded(path) {
  // NOFOLLOW protects the final component; NONBLOCK prevents a replaced FIFO from hanging open.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    check(stat.isFile() && stat.size <= MAX_BYTES, "expected regular file <= 1 MiB");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    check(size <= MAX_BYTES, "file exceeds 1 MiB");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
  } finally {
    await file.close();
  }
}

async function artifacts(directory) {
  const files = new Map();
  let stat;
  try {
    stat = await lstat(directory);
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  check(stat.isDirectory() && !stat.isSymbolicLink(), "expected non-symlink directory");
  const expected = new Set(
    config.arms.flatMap(({ id }) =>
      Array.from({ length: config.shards }, (_, shard) => `${id}-${shard}.json`),
    ),
  );
  const entries = await opendir(directory);
  for await (const entry of entries) {
    check(
      expected.delete(entry.name) && entry.isFile() && !entry.isSymbolicLink(),
      "unexpected file or non-regular artifact",
    );
    files.set(entry.name, await readBounded(join(directory, entry.name)));
  }
  return files;
}

function summarize(files, arm, headSha, model) {
  const trials = [];
  let completed = true;
  for (let shard = 0; shard < config.shards; shard++) {
    const name = `${arm.id}-${shard}.json`;
    if (!files.has(name)) {
      completed = false;
      continue;
    }
    const report = validate(files.get(name), arm.id, shard, headSha, model);
    completed &&= report.completed;
    trials.push(...report.trials);
  }
  const planned = config.dataset.tasks.length;
  completed &&= trials.length === planned;
  const errors =
    planned - trials.length + trials.filter((trial) => trial.error || trial.reward === null).length;
  const passed = trials.filter((trial) => !trial.error && trial.reward === 1).length;
  return {
    label: arm.label + (arm.version ? ` (${arm.version})` : ""),
    passed: `${passed}/${planned}`,
    errors,
    score:
      completed && errors === 0
        ? trials.reduce((sum, trial) => sum + trial.reward / planned, 0) * 100
        : null,
    time: completed
      ? `${(trials.reduce((sum, trial) => sum + trial.durationMs / planned, 0) / 1000).toFixed(1)}s`
      : "—",
    cost:
      completed && trials.every((trial) => trial.costUsd !== null)
        ? `$${trials.reduce((sum, trial) => sum + trial.costUsd, 0).toFixed(2)}`
        : "—",
  };
}

async function renderReport({ directory, headSha, model, runUrl }) {
  check(typeof headSha === "string" && /^[0-9a-f]{40}$/.test(headSha), "head SHA");
  check(
    typeof model === "string" &&
      model.length <= 200 &&
      /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model),
    "root model",
  );
  check(
    typeof runUrl === "string" &&
      /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+(?:\/attempts\/[0-9]+)?$/.test(
        runUrl,
      ),
    "run URL",
  );
  const files = await artifacts(directory);
  const rows = config.arms.map((arm) => summarize(files, arm, headSha, model));
  const baseline = rows[config.arms.findIndex((arm) => arm.id === "baseline")].score;
  return [
    MARKER,
    `Terminal-Bench ${config.dataset.version} · ${config.dataset.tasks.length} tasks · ${config.attempts} attempt · Root model: ${model} · [Run](${runUrl})`,
    "",
    "| Harness | Passed | Score | Δ baseline | Errors | Avg time | Cost |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map((row) => {
      const delta = row.score !== null && baseline !== null ? row.score - baseline : null;
      const difference = delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pp`;
      return `| ${row.label} | ${row.passed} | ${row.score === null ? "—" : `${row.score.toFixed(1)}%`} | ${difference} | ${row.errors} | ${row.time} | ${row.cost} |`;
    }),
    "",
    "— = incomplete/unreported; error arms are unscored.",
    "",
  ].join("\n");
}

// Require this module from the checked-out, same-repository PR head, never an artifact.
// The caller owns checkout trust and contents:read/actions:read/pull-requests:write permissions.
async function publishReport({ github, context, core, directory, model }) {
  const pr = context.payload.pull_request;
  const headSha = pr ? pr.head.sha : context.sha;
  const { owner, repo } = context.repo;
  const runUrl = `${context.serverUrl || "https://github.com"}/${owner}/${repo}/actions/runs/${context.runId}`;
  const body = await renderReport({ directory, headSha, model, runUrl });
  await core.summary.addRaw(body).write();
  const repository = `${owner}/${repo}`;
  if (!pr || pr.head.repo?.full_name !== repository || pr.state === "closed") return body;

  let comment;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const { data } = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
      page,
    });
    comment = data.find(
      (item) =>
        item.user?.type === "Bot" &&
        item.user.login === "github-actions[bot]" &&
        typeof item.body === "string" &&
        item.body.includes(MARKER),
    );
    if (comment || data.length < 100) break;
    // Never create a duplicate when the bounded scan cannot establish that no sticky comment exists.
    if (page === MAX_COMMENT_PAGES) return body;
  }
  const { data: current } = await github.rest.pulls.get({ owner, repo, pull_number: pr.number });
  if (
    current.state !== "open" ||
    current.head.sha !== headSha ||
    current.head.repo?.full_name !== repository
  )
    return body;
  if (comment) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: comment.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body });
  }
  return body;
}

module.exports = { renderReport, publishReport };
