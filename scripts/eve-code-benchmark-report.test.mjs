import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import report from "./eve-code-benchmark-report.cjs";

const require = createRequire(import.meta.url);
const config = require("./eve-code-benchmark-config.json");
const { renderReport, publishReport } = report;
const headSha = "a".repeat(40);
const model = "openai/gpt-5.6-terra";
const runUrl = "https://github.com/vercel/eve/actions/runs/123";
const marker = "<!-- eve-code-benchmark -->";
const repository = "vercel/eve";

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), "eve-code-report-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function artifact(arm = "baseline", shard = 0) {
  const { name, version, commit } = config.dataset;
  return {
    schemaVersion: 1,
    headSha,
    runnerRevision: config.runnerRevision,
    baselineRevision: config.baselineRevision,
    model,
    arm,
    shard,
    shards: config.shards,
    dataset: { name, version, commit },
    trials: config.dataset.tasks
      .filter((_, index) => index % config.shards === shard)
      .map((task) => ({
        task,
        attempt: 1,
        reward: 1,
        durationMs: 1000,
        costUsd: 0.01,
        error: false,
      })),
    completed: true,
  };
}

async function put(path, value, filename = `${value.arm}-${value.shard}.json`) {
  await writeFile(join(path, filename), JSON.stringify(value));
}

async function fill(path, transform = () => {}) {
  for (const { id } of config.arms) {
    for (let shard = 0; shard < config.shards; shard++) {
      const value = artifact(id, shard);
      transform(value);
      await put(path, value);
    }
  }
}

const render = (directory, overrides = {}) =>
  renderReport({ directory, headSha, model, runUrl, ...overrides });
const row = (body, id) =>
  body
    .split("\n")
    .find((line) => line.startsWith(`| ${config.arms.find((arm) => arm.id === id).label}`));

test("full 89-task comparison uses reward mean, percentage-point deltas and pinned labels", async (t) => {
  const path = await directory(t);
  await fill(path, (value) => {
    if (value.arm === "baseline")
      value.trials.forEach((trial) => {
        trial.reward = 0.5;
      });
  });
  const body = await render(path);
  assert.equal(config.dataset.tasks.length, 89);
  assert.equal(body.split("\n").filter((line) => line.startsWith("| ")).length, 8);
  assert.ok(body.startsWith(marker));
  assert.ok(
    body.includes(
      `Terminal-Bench 2.0 · 89 tasks · 1 attempt · Root model: ${model} · [Run](${runUrl})`,
    ),
  );
  assert.match(row(body, "baseline"), /\| 0\/89 \| 50\.0% \| 0\.0 pp \| 0 \| 1\.0s \| \$0\.89 \|$/);
  assert.match(
    row(body, "candidate"),
    /\| 89\/89 \| 100\.0% \| \+50\.0 pp \| 0 \| 1\.0s \| \$0\.89 \|$/,
  );
  for (const arm of config.arms.filter((arm) => arm.version))
    assert.ok(body.includes(`${arm.label} (${arm.version})`));
  assert.doesNotMatch(body, /smoke|all models|identical models/i);
});

test("missing directory/files remain incomplete with planned denominators", async (t) => {
  const path = await directory(t);
  assert.match(
    row(await render(join(path, "missing")), "baseline"),
    /0\/89 \| — \| — \| 89 \| — \| —/,
  );
  await put(path, artifact());
  const body = await render(path);
  assert.match(row(body, "baseline"), /12\/89 \| — \| — \| 77 \| — \| —/);
  assert.match(row(body, "candidate"), /0\/89 \| — \| — \| 89 \| — \| —/);
});

test("missing tasks, null rewards, errors and unfinished shards never score; errors count tasks once", async (t) => {
  const path = await directory(t);
  await fill(path, (value) => {
    if (value.shard !== 0) return;
    if (value.arm === "baseline") {
      value.trials.pop();
      value.trials[0].reward = null;
      value.trials[1].error = true;
      value.trials[1].reward = null;
    }
    if (value.arm === "candidate") value.completed = false;
    if (value.arm === "codex") value.trials[0].error = true;
  });
  const body = await render(path);
  assert.match(row(body, "baseline"), /86\/89 \| — \| — \| 3 \| — \| —/);
  assert.match(row(body, "candidate"), /89\/89 \| — \| — \| 0 \| — \| —/);
  assert.match(row(body, "codex"), /88\/89 \| — \| — \| 1/);
  assert.match(row(body, "hermes"), /89\/89 \| 100\.0% \| — \| 0/);
});

test("missing costs are not zero; complete zero-cost runs and negative deltas are reported", async (t) => {
  const path = await directory(t);
  await fill(path, (value) => {
    if (value.arm === "candidate") value.trials[0].costUsd = null;
    if (value.arm === "codex")
      value.trials.forEach((trial) => {
        trial.costUsd = 0;
        trial.reward = 0;
      });
  });
  const body = await render(path);
  assert.match(row(body, "candidate"), /100\.0% \| 0\.0 pp \| 0 \| 1\.0s \| — \|$/);
  assert.match(row(body, "codex"), /0\/89 \| 0\.0% \| -100\.0 pp \| 0 \| 1\.0s \| \$0\.00 \|$/);
});

test("rejects wrong provenance, pins, schema, model and file identity", async (t) => {
  const path = await directory(t);
  for (const change of [
    { schemaVersion: "1" },
    { headSha: "b".repeat(40) },
    { runnerRevision: "b".repeat(40) },
    { baselineRevision: "b".repeat(40) },
    { model: "other/model" },
    { arm: "candidate" },
    { shard: 1 },
    { shards: 7 },
    { completed: 1 },
    { extra: true },
    { trials: {} },
    { dataset: { name: "terminal-bench", version: "2.0", commit: "b".repeat(40) } },
    { dataset: { ...artifact().dataset, tasks: [] } },
  ]) {
    await put(path, { ...artifact(), ...change }, "baseline-0.json");
    await assert.rejects(render(path), /Invalid benchmark report/);
  }
  const value = artifact();
  delete value.completed;
  await put(path, value);
  await assert.rejects(render(path), /file schema/);
});

test("rejects invalid trial schemas, finite/range/type violations, tasks and attempts", async (t) => {
  const path = await directory(t);
  for (const change of [
    { task: "unknown" },
    { task: config.dataset.tasks[1] },
    { attempt: 0 },
    { attempt: 2 },
    { reward: -1 },
    { reward: 1.01 },
    { reward: "1" },
    { durationMs: null },
    { durationMs: -1 },
    { durationMs: Number.MAX_VALUE },
    { costUsd: -1 },
    { costUsd: "0" },
    { error: 0 },
    { extra: true },
    { reward: undefined },
    { costUsd: undefined },
  ]) {
    const value = artifact();
    Object.assign(value.trials[0], change);
    await put(path, value);
    await assert.rejects(render(path), /Invalid benchmark report/);
  }
  await writeFile(
    join(path, "baseline-0.json"),
    JSON.stringify(artifact()).replace('"reward":1', '"reward":1e999'),
  );
  await assert.rejects(render(path), /trial values/);
});

test("rejects duplicate and excess trials", async (t) => {
  const path = await directory(t);
  const value = artifact();
  value.trials[1] = value.trials[0];
  await put(path, value);
  await assert.rejects(render(path), /duplicate/);
  value.trials.push(value.trials[0]);
  await put(path, value);
  await assert.rejects(render(path), /trial count/);
});

test("rejects malformed, oversized, unexpected, non-regular and symlink artifacts", async (t) => {
  const path = await directory(t);
  const file = join(path, "baseline-0.json");
  for (const raw of ["{", "null", Buffer.from([0xff]), " ".repeat(1024 * 1024 + 1)]) {
    await writeFile(file, raw);
    await assert.rejects(render(path));
  }
  await rm(file);
  await mkdir(file);
  await assert.rejects(render(path), /non-regular/);
  await rm(file, { recursive: true });
  await symlink(join(path, "absent"), file);
  await assert.rejects(render(path), /non-regular/);
  await rm(file);
  await put(path, artifact(), "baseline-8.json");
  await assert.rejects(render(path), /unexpected file/);
  const link = join(path, "directory-link");
  await symlink(path, link);
  await assert.rejects(render(link), /non-symlink directory/);
});

test("rejects unsafe caption inputs", async (t) => {
  const path = await directory(t);
  for (const overrides of [
    { headSha: "bad" },
    { model: "x\n| injected" },
    { model: "" },
    { runUrl: "javascript:alert(1)" },
    { runUrl: `${runUrl})\ntext` },
  ]) {
    await assert.rejects(render(path, overrides), /Invalid benchmark report/);
  }
});

async function publication(t, options = {}) {
  const path = await directory(t);
  const calls = [];
  const currentHead = { sha: headSha, repo: { full_name: repository } };
  const context = {
    repo: { owner: "vercel", repo: "eve" },
    sha: "b".repeat(40),
    runId: 123,
    payload: options.dispatch
      ? {}
      : {
          pull_request: {
            number: 42,
            head: { ...currentHead, repo: { full_name: options.fork ? "alice/eve" : repository } },
          },
        },
  };
  await put(path, { ...artifact(), headSha: options.dispatch ? context.sha : headSha });
  const github = {
    rest: {
      issues: {
        listComments: async (args) => {
          calls.push(["list", args]);
          return { data: options.page?.(args.page) ?? [] };
        },
        createComment: async (args) => calls.push(["create", args]),
        updateComment: async (args) => calls.push(["update", args]),
      },
      pulls: {
        get: async (args) => {
          calls.push(["head", args]);
          return { data: { state: "open", head: currentHead, ...options.current } };
        },
      },
    },
  };
  const core = {
    summary: {
      addRaw(body) {
        calls.push(["summary", body]);
        return this;
      },
      async write() {
        calls.push(["write"]);
      },
    },
  };
  const body = await publishReport({ github, context, core, directory: path, model });
  assert.equal(calls[0][1], body);
  assert.equal(calls[1][0], "write");
  return { calls, body };
}

test("publication creates or updates only the GitHub Actions bot marker, then checks head immediately before mutation", async (t) => {
  const human = { id: 1, user: { type: "User", login: "github-actions[bot]" }, body: marker };
  const otherBot = { id: 2, user: { type: "Bot", login: "other[bot]" }, body: marker };
  const unrelated = {
    id: 3,
    user: { type: "Bot", login: "github-actions[bot]" },
    body: "other report",
  };
  const created = await publication(t, { page: () => [human, otherBot, unrelated] });
  assert.deepEqual(
    created.calls.map(([kind]) => kind),
    ["summary", "write", "list", "head", "create"],
  );
  assert.equal(created.calls.at(-1)[1].body, created.body);
  const updated = await publication(t, {
    page: (page) =>
      page === 1 ? Array(100).fill(human) : [{ ...unrelated, id: 9, body: `old\n${marker}` }],
  });
  assert.deepEqual(
    updated.calls.map(([kind]) => kind),
    ["summary", "write", "list", "list", "head", "update"],
  );
  assert.equal(updated.calls.at(-1)[1].comment_id, 9);
  assert.equal(updated.calls.at(-1)[1].body, updated.body);
});

test("publication still summarizes dispatch, fork, closed and stale runs without comments", async (t) => {
  for (const options of [
    { dispatch: true },
    { fork: true },
    { current: { state: "closed" } },
    { current: { head: { sha: "c".repeat(40), repo: { full_name: repository } } } },
    { current: { head: { sha: headSha, repo: { full_name: "alice/eve" } } } },
  ]) {
    const { calls } = await publication(t, options);
    assert.ok(!calls.some(([kind]) => kind === "create" || kind === "update"));
    if (options.dispatch || options.fork) assert.equal(calls.length, 2);
  }
});

test("publication bounds pagination and does not create a duplicate after truncation", async (t) => {
  const { calls } = await publication(t, {
    page: () => Array(100).fill({ user: { type: "User" }, body: marker }),
  });
  const pages = calls.filter(([kind]) => kind === "list");
  assert.equal(pages.length, 10);
  assert.equal(pages.at(-1)[1].page, 10);
  assert.ok(pages.every(([, args]) => args.per_page === 100 && args.issue_number === 42));
  assert.ok(!calls.some(([kind]) => kind === "create" || kind === "update"));
});
