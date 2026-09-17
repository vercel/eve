import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/eve-code-benchmark.yml", import.meta.url),
  "utf8",
);
const config = JSON.parse(
  await readFile(new URL("./eve-code-benchmark-config.json", import.meta.url), "utf8"),
);

test("full comparison has all six arms and eight shards, without automatic runs on unlabelled PRs", () => {
  const arms = workflow.match(/arm: \[([^\]]+)\]/)[1].split(", ");
  const shards = workflow
    .match(/shard: \[([^\]]+)\]/)[1]
    .split(", ")
    .map(Number);
  assert.deepEqual(
    arms,
    config.arms.map((arm) => arm.id),
  );
  assert.deepEqual(
    shards,
    Array.from({ length: config.shards }, (_, index) => index),
  );
  assert.equal(config.dataset.tasks.length * arms.length, 534);
  assert.match(
    workflow,
    /contains\(github.event.pull_request.labels.\*.name, 'eve-code-benchmark'\)/,
  );
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /max-parallel: 8/);
  assert.match(workflow, /timeout-minutes: 360/);
  assert.doesNotMatch(
    workflow,
    /--task log-summary-date-ranges|terminal-small|pull_request_target|workflow_run/,
  );
});

test("ignored events cannot cancel the full comparison", () => {
  const group = workflow.match(/group: >-\n([\s\S]*?)\n  cancel-in-progress:/)[1];
  const expressions = [...group.matchAll(/\$\{\{([\s\S]*?)\}\}/g)];
  assert.equal(expressions.length, 2);
  const context = (action, labelled, label = "eve-code-benchmark") => ({
    event_name: "pull_request",
    event: {
      action,
      label: { name: label },
      pull_request: { labels: labelled ? [{ name: "eve-code-benchmark" }] : [] },
    },
  });
  // GitHub's object-filter syntax becomes a JavaScript map for these event fixtures.
  const expression = expressions[1][1].replace(
    "github.event.pull_request.labels.*.name",
    "github.event.pull_request.labels.map(label => label.name)",
  );
  const evaluate = new Function("github", "contains", `return (${expression});`);
  const contains = (values, value) => values.includes(value);
  assert.equal(evaluate(context("synchronize", true), contains), true);
  assert.equal(evaluate(context("labeled", true), contains), true);
  assert.equal(evaluate(context("synchronize", false), contains), false);
  assert.equal(evaluate(context("labeled", true, "unrelated"), contains), false);
});

test("pins the runner and original extension baseline while sharing the current framework", () => {
  assert.match(workflow, new RegExp(`BENCHMARK_REVISION: ${config.runnerRevision}`));
  assert.equal(config.baselineRevision, "ca27ee898e28dc90df5f0bb4ef713a4aad2fa5f3");
  assert.match(
    workflow,
    /if: matrix.arm == 'baseline'\n\s+run: node scripts\/eve-code-benchmark.mjs stage-baseline/,
  );
  assert.match(workflow, /if: matrix.arm == 'baseline' \|\| matrix.arm == 'candidate'/);
  assert.match(
    workflow,
    /pnpm install --frozen-lockfile\n\s+pnpm exec turbo run build --filter=eve-code/,
  );
  assert.match(workflow, /node scripts\/eve-code-benchmark.mjs run/);
  assert.match(workflow, /node --test scripts\/eve-code-benchmark\*.test.mjs/);
});

test("uses exact same-repository source and least-privilege credentials", () => {
  assert.match(workflow, /github.event.pull_request.head.repo.full_name == github.repository/);
  assert.match(
    workflow,
    /TESTED_SHA: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/,
  );
  assert.equal(
    (workflow.match(/ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/g) ?? [])
      .length,
    2,
  );
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 2);
  assert.match(workflow, /ssh-key: \$\{\{ secrets.EVE_BENCH_SSH_KEY \}\}/);
  assert.match(
    workflow,
    /- name: Run full benchmark shard\n\s+env:\n\s+AI_GATEWAY_API_KEY: \$\{\{ secrets.AI_GATEWAY_API_KEY \}\}/,
  );
  for (const match of workflow.matchAll(/uses: (\S+)/g)) assert.match(match[1], /@[a-f0-9]{40}$/);
});

test("publishes all same-attempt shard results even when a harness fails", () => {
  const publish = workflow.split("\n  publish:\n")[1];
  assert.match(
    publish,
    /needs: benchmark\n\s+if: always\(\) && needs.benchmark.result != 'skipped'/,
  );
  assert.match(publish, /contents: read\n\s+actions: read\n\s+pull-requests: write/);
  assert.match(publish, /pattern: eve-code-result-\*-\$\{\{ github.run_attempt \}\}/);
  assert.match(publish, /merge-multiple: true/);
  assert.match(publish, /require\('\.\/scripts\/eve-code-benchmark-report.cjs'\)/);
  assert.doesNotMatch(publish, /secrets\.|npm |pnpm |run-id:|github-token:/);
  assert.match(workflow, /- name: Upload shard result\n\s+if: always\(\)/);
  assert.match(
    workflow,
    /name: eve-code-result-\$\{\{ matrix.arm \}\}-\$\{\{ matrix.shard \}\}-\$\{\{ github.run_attempt \}\}/,
  );
});

test("public fixture resolves the workspace extension and installed runtime", async () => {
  const fixture = new URL("../apps/fixtures/eve-code-bench/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", fixture), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies.eve, "workspace:*");
  assert.equal(pkg.dependencies["eve-code"], "workspace:*");
  assert.equal(pkg.dependencies["@vercel/connect"], "catalog:");
  assert.match(
    await readFile(new URL("agent/extensions/code.ts", fixture), "utf8"),
    /export default code\(\{\}\)/,
  );
  assert.match(
    await readFile(new URL("agent/agent.ts", fixture), "utf8"),
    /process\.env\.E0_MODEL/,
  );
});
