import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const workflow = await readFile(
  new URL("../.github/workflows/eve-code-benchmark.yml", import.meta.url),
  "utf8",
);
const revision = "4c87e8d4f0cca6965f5a4d0415a22fa38776d871";
const sha = "a".repeat(40);
const model = "openai/gpt-5.6-terra";
const repository = "vercel/eve";
const marker = "<!-- eve-code-benchmark -->";
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Execute the actual inline workflow script, not a second implementation of publication.
function step(name) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function block(text, key, indent) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === key);
  assert.notEqual(start, -1, `Missing block: ${key}`);
  const result = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith(" ".repeat(indent))) break;
    result.push(line.slice(indent));
  }
  return result.join("\n").trimEnd();
}

const reportScript = block(step("Summarize smoke execution"), "script: &report_smoke |", 12);
const executeReport = new AsyncFunction(
  "require",
  "context",
  "github",
  "core",
  "process",
  reportScript,
);

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), "eve-code-benchmark-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function report() {
  return {
    schemaVersion: "1",
    mode: "baseline",
    manifest: {
      schemaVersion: "2",
      mode: "baseline",
      harness: "e0",
      runnerRevision: revision,
      agent: { repository, path: "apps/fixtures/eve-code-bench" },
      arms: { baseline: { sourceRevision: sha, job: "jobs/baseline" } },
      model,
      dataset: "swe-lean",
      task: "log-summary-date-ranges",
      attempts: 1,
      concurrency: 1,
      nativeBuild: false,
    },
    results: { baseline: { summary: { tasks: 1, attempts: 1, resolved: 1, meanReward: 1 } } },
  };
}

async function publication(t, options = {}) {
  const root = await directory(t);
  const file = join(root, "report.json");
  if (!options.missing) {
    await writeFile(file, options.raw ?? JSON.stringify(options.report ?? report()));
  }
  if (options.symlink) {
    await symlink(file, join(root, "link.json"));
  }
  const calls = [];
  const warnings = [];
  const info = [];
  const summaries = [];
  const context = {
    repo: { owner: "vercel", repo: "eve" },
    sha: "b".repeat(40), // The PR merge SHA must never become the tested source SHA.
    runId: 123,
    payload: options.dispatch
      ? {}
      : {
          pull_request: {
            number: 42,
            head: { sha, repo: { full_name: options.fork ? "alice/eve" : repository } },
          },
        },
  };
  const github = {
    rest: {
      issues: {
        listComments: async (args) => {
          calls.push(["list", args]);
          return { data: options.pages?.[args.page - 1] ?? [] };
        },
        updateComment: async (args) => calls.push(["update", args]),
        createComment: async (args) => calls.push(["create", args]),
      },
      pulls: {
        get: async (args) => {
          calls.push(["head", args]);
          return {
            data: {
              state: options.closed ? "closed" : "open",
              head: {
                sha: options.stale ? "c".repeat(40) : sha,
                repo: { full_name: options.currentRepository ?? repository },
              },
            },
          };
        },
      },
    },
  };
  const core = {
    warning: (message) => warnings.push(message),
    info: (message) => info.push(message),
    summary: {
      addRaw(body) {
        summaries.push(body);
        return this;
      },
      async write() {},
    },
  };
  await executeReport(require, context, github, core, {
    env: {
      PUBLISH_COMMENT: options.summaryOnly ? "false" : "true",
      EXECUTION_RESULT: options.status ?? "success",
      REPORT_PATH: options.symlink ? join(root, "link.json") : file,
      BENCHMARK_REVISION: revision,
      BENCHMARK_MODEL: model,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ATTEMPT: "2",
    },
  });
  return {
    root,
    calls,
    warnings,
    info,
    summaries,
    body: calls.find(([kind]) => ["update", "create"].includes(kind))?.[1].body,
  };
}

test("workflow uses exact same-repository PR head or dispatch SHA, never a privileged PR trigger", () => {
  assert.match(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_run/);
  assert.match(
    step("Checkout exact agent head"),
    /ref: \$\{\{ github.event.pull_request.head.sha \|\| github.sha \}\}/,
  );
  assert.match(
    step("Record checked out SHA"),
    /actual_sha="\$\(git rev-parse HEAD\)"\n\s+test "\$actual_sha" = "\$EXPECTED_SHA"/,
  );
  assert.match(
    workflow,
    /group: eve-code-benchmark-\$\{\{ github.event.pull_request.number \|\| github.ref \}\}\n  cancel-in-progress: true/,
  );
  assert.match(
    workflow,
    /benchmark:\n    if: \$\{\{ github.event_name != 'pull_request' \|\| github.event.pull_request.head.repo.full_name == github.repository \}\}/,
  );
  for (const match of workflow.matchAll(/uses: (\S+)/g)) {
    assert.match(match[1], /@[0-9a-f]{40}$/, `Unpinned action: ${match[1]}`);
  }
  assert.equal((workflow.match(/uses: actions\/checkout@/g) ?? []).length, 2);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
});

test("builds local eve-code dependency graph and installs the independently pinned runner", () => {
  assert.match(workflow, new RegExp(`BENCHMARK_REVISION: ${revision}\\n`));
  assert.match(
    workflow,
    /BENCHMARK_MODEL: \$\{\{ vars.EVE_CODE_BENCH_MODEL \|\| 'openai\/gpt-5.6-terra' \}\}/,
  );
  assert.match(
    step("Build local eve and eve-code"),
    /run: pnpm exec turbo run build --filter=eve-code\n/,
  );
  assert.match(
    step("Checkout pinned benchmark runner separately"),
    /repository: vercel-labs\/eve-bench\n\s+ref: \$\{\{ env.BENCHMARK_REVISION \}\}\n\s+path: .eve-bench-runner/,
  );
  assert.match(
    step("Install benchmark runner dependencies"),
    /working-directory: .eve-bench-runner/,
  );
  assert.match(
    step("Install benchmark runner dependencies"),
    /test "\$\(git rev-parse HEAD\)" = "\$BENCHMARK_REVISION"\n\s+npm ci/,
  );
  assert.match(
    step("Check benchmark wiring and publication"),
    /node --test scripts\/eve-code-benchmark.test.mjs/,
  );
  assert.doesNotMatch(workflow, /\bnpx\b|--before |--after |\bnpm install/);
});

test("only the bounded smoke step gets the gateway secret; publication has no checkout or execution", () => {
  const [benchmark, publish] = workflow.split("\n  publish:\n");
  assert.match(workflow, /\npermissions: \{\}\n/);
  assert.match(benchmark, /permissions:\n      contents: read\n    runs-on:/);
  assert.match(
    publish,
    /permissions:\n      actions: read\n      pull-requests: write\n    runs-on:/,
  );
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 1);
  assert.match(
    step("Run terminal-only single smoke task"),
    /AI_GATEWAY_API_KEY: \$\{\{ secrets.AI_GATEWAY_API_KEY \}\}/,
  );
  assert.match(benchmark, /timeout-minutes: 30/);
  assert.match(step("Run terminal-only single smoke task"), /timeout-minutes: 20/);
  assert.match(publish, /timeout-minutes: 5/);
  assert.doesNotMatch(publish, /checkout@|\brun:|secrets\.|contents:|id-token:|issues: write/);
  assert.match(
    publish,
    /always\(\) && github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository/,
  );
  assert.match(step("Publish sticky smoke comment"), /script: \*report_smoke/);
  assert.doesNotMatch(reportScript, /child_process|\bexec\(|\beval\(|\bimport\(/);
});

test("shell passes the fixed smoke arguments and treats model and workspace as data", async (t) => {
  const root = await directory(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  const argumentsFile = join(root, "arguments");
  await writeFile(join(bin, "node"), '#!/bin/bash\nprintf "%s\\0" "$@" > "$ARGUMENTS_FILE"\n', {
    mode: 0o755,
  });
  const modelInput = 'provider/model $(touch not-executed); "quoted"';
  await exec(
    "/bin/bash",
    ["-euo", "pipefail", "-c", block(step("Run terminal-only single smoke task"), "run: |", 10)],
    {
      cwd: root,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        ARGUMENTS_FILE: argumentsFile,
        AI_GATEWAY_API_KEY: "test-only",
        GITHUB_WORKSPACE: `${root}/workspace with spaces`,
        GITHUB_REPOSITORY: repository,
        TESTED_SHA: sha,
        BENCHMARK_MODEL: modelInput,
      },
    },
  );
  assert.deepEqual((await readFile(argumentsFile, "utf8")).split("\0").slice(0, -1), [
    ".eve-bench-runner/release/action-runner.mjs",
    "--harness",
    "e0",
    "--agent-before",
    `${root}/workspace with spaces/apps/fixtures/eve-code-bench`,
    "--agent-ref",
    sha,
    "--agent-repository",
    repository,
    "--agent-path",
    "apps/fixtures/eve-code-bench",
    "--model",
    modelInput,
    "--dataset",
    "swe-lean",
    "--task",
    "log-summary-date-ranges",
    "--attempts",
    "1",
    "--concurrency",
    "1",
    "--native-build",
    "false",
    "--output",
    "benchmark-results",
  ]);
});

test("source proof checks workspace resolution and compares runner bundle hashes, not just version strings", () => {
  const snapshot = step("Snapshot workspace source identity");
  assert.match(
    snapshot,
    /import \{ hashTree \} from '\.\/.eve-bench-runner\/src\/harnesses\/e0\/snapshot.ts'/,
  );
  assert.match(snapshot, /for \(const name of \['eve', 'eve-code'\]\)/);
  assert.match(
    snapshot,
    /assert.equal\(await realpath\(`\$\{agent\}\/node_modules\/\$\{name\}`\), await realpath\(`packages\/\$\{name\}`\)/,
  );
  for (const key of ["gitSha", "agentSha256", "extensionSha256", "eveDistSha256"])
    assert.match(snapshot, new RegExp(`${key}:`));
  const verify = step("Verify executed bundle source identity");
  assert.match(verify, /benchmark-results\/jobs\/baseline\/job.json/);
  assert.match(verify, /assert.equal\(job.bundle\?\.source\?\.\[key\], value/);
  assert.doesNotMatch(verify, /continue-on-error/);
  assert.ok(
    workflow.indexOf(snapshot) < workflow.indexOf(step("Run terminal-only single smoke task")),
  );
  assert.ok(
    workflow.indexOf(verify) > workflow.indexOf(step("Run terminal-only single smoke task")),
  );
});

test("executed bundle verification fails on missing or changed source identity", async (t) => {
  const root = await directory(t);
  const jobPath = join(root, "benchmark-results/jobs/baseline/job.json");
  await mkdir(join(root, "benchmark-results/jobs/baseline"), { recursive: true });
  const expected = {
    gitSha: sha,
    agentSha256: "1".repeat(64),
    extensionSha256: "2".repeat(64),
    eveDistSha256: "3".repeat(64),
  };
  await writeFile(join(root, "eve-code-benchmark-source.json"), JSON.stringify(expected));
  const code = block(step("Verify executed bundle source identity"), "run: |", 10)
    .split("<<'NODE'\n")[1]
    .replace(/\nNODE$/, "");
  const verify = () =>
    exec(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: root,
      env: { ...process.env, RUNNER_TEMP: root },
    });
  await writeFile(jobPath, JSON.stringify({ bundle: { source: expected } }));
  await verify();
  for (const key of Object.keys(expected)) {
    await writeFile(
      jobPath,
      JSON.stringify({ bundle: { source: { ...expected, [key]: "wrong" } } }),
    );
    await assert.rejects(verify(), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, new RegExp(`Executed bundle source mismatch: ${key}`));
      return true;
    });
  }
  await writeFile(jobPath, JSON.stringify({ bundle: {} }));
  await assert.rejects(verify(), { code: 1 });
});

test("reporting and uploads run after failures, with one named same-run/attempt report download", () => {
  for (const name of [
    "Summarize smoke execution",
    "Upload smoke report",
    "Upload smoke job artifacts",
    "Publish sticky smoke comment",
  ]) {
    assert.match(step(name), /if: \$\{\{ always\(\) \}\}/);
  }
  for (const name of ["Upload smoke report", "Upload smoke job artifacts"]) {
    assert.match(step(name), /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
    assert.match(step(name), /retention-days: 7/);
    assert.doesNotMatch(step(name), /include-hidden-files: true/);
  }
  const download = step("Download only this attempt's known report artifact");
  assert.match(download, /continue-on-error: true/);
  assert.match(download, /name: eve-code-benchmark-report-\$\{\{ github.run_attempt \}\}/);
  assert.match(
    step("Upload smoke report"),
    /name: eve-code-benchmark-report-\$\{\{ github.run_attempt \}\}/,
  );
  assert.doesNotMatch(download, /\brun-id:|\brepository:|\bpattern:|\bgithub-token:/);
});

test("creates an honest sticky comment from numeric results and trusted run identity", async (t) => {
  const result = await publication(t);
  assert.deepEqual(
    result.calls.map(([kind]) => kind),
    ["list", "head", "create"],
  );
  assert.equal(result.calls.at(-1)[1].issue_number, 42);
  assert.match(result.body, /^<!-- eve-code-benchmark -->/);
  assert.match(result.body, new RegExp(`Tested head SHA:.*${sha}`));
  assert.doesNotMatch(result.body, new RegExp("b".repeat(40)));
  assert.match(result.body, /Terminal-only single smoke task/);
  assert.match(result.body, /not full swe-lean coverage, does not test MCP tasks/);
  assert.match(result.body, /not a before\/after comparison/);
  assert.match(result.body, /resolved: 1; mean reward: 1.000/);
  assert.match(result.body, /Execution\/setup status: \*\*success\*\*/);
  assert.match(result.body, /https:\/\/github.com\/vercel\/eve\/actions\/runs\/123\/attempts\/2/);
  assert.deepEqual(result.warnings, []);
});

test("updates only the sticky comment owned by github-actions, including later pages", async (t) => {
  const impostor = { id: 1, user: { login: "alice", type: "User" }, body: marker };
  const otherBot = { id: 2, user: { login: "other[bot]", type: "Bot" }, body: marker };
  const ours = {
    id: 3,
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${marker}\nold`,
  };
  const result = await publication(t, { pages: [[...Array(99).fill(impostor), otherBot], [ours]] });
  assert.deepEqual(
    result.calls.map(([kind]) => kind),
    ["list", "list", "head", "update"],
  );
  assert.equal(result.calls.at(-1)[1].comment_id, 3);
  assert.equal(result.calls[1][1].page, 2);
});

test("skips stale SHA, closed PR, or changed repository immediately before mutation", async (t) => {
  for (const options of [{ stale: true }, { closed: true }, { currentRepository: "alice/eve" }]) {
    const result = await publication(t, options);
    assert.deepEqual(
      result.calls.map(([kind]) => kind),
      ["list", "head"],
    );
    assert.equal(result.body, undefined);
    assert.equal(result.info.length, 1);
  }
});

test("forks and dispatches cannot publish a PR comment", async (t) => {
  for (const options of [{ fork: true }, { dispatch: true }]) {
    const result = await publication(t, options);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.summaries, []);
  }
});

test("bounds comment pagination without creating a duplicate when the search is exhausted", async (t) => {
  const result = await publication(t, {
    pages: Array(10).fill(Array(100).fill({ user: { login: "alice" } })),
  });
  assert.equal(result.calls.length, 10);
  assert.ok(result.calls.every(([kind]) => kind === "list"));
  assert.match(result.warnings.at(-1), /search limit reached/);
});

test("missing, malformed, oversized, and symlinked reports fall back without echoing artifact text", async (t) => {
  for (const options of [
    { missing: true },
    { raw: "<script>artifact-code</script>" },
    { raw: "x".repeat(256 * 1024 + 1) },
    { symlink: true },
  ]) {
    const result = await publication(t, { ...options, status: "failure" });
    assert.match(result.body, /\*\*failure\*\*/);
    assert.match(result.body, /Report unavailable or invalid/);
    assert.match(result.body, /No task result is claimed/);
    assert.doesNotMatch(result.body, /artifact-code|resolved: 1/);
    assert.equal(result.warnings.length, 1);
  }
});

test("rejects mismatched source, runner, scope, and numeric metrics from untrusted reports", async (t) => {
  for (const mutate of [
    (r) => {
      r.manifest.arms.baseline.sourceRevision = "c".repeat(40);
    },
    (r) => {
      r.manifest.runnerRevision = "d".repeat(40);
    },
    (r) => {
      r.manifest.agent.repository = "alice/eve";
    },
    (r) => {
      r.manifest.agent.path = "other-agent";
    },
    (r) => {
      r.manifest.task = "unsupported-mcp-task";
    },
    (r) => {
      r.manifest.model = "other/model";
    },
    (r) => {
      r.manifest.harness = "eve";
    },
    (r) => {
      r.manifest.attempts = 2;
    },
    (r) => {
      r.manifest.concurrency = 2;
    },
    (r) => {
      r.manifest.nativeBuild = true;
    },
    (r) => {
      r.results.baseline.summary.tasks = 2;
    },
    (r) => {
      r.results.baseline.summary.resolved = "[click](https://evil.example)";
    },
    (r) => {
      r.results.baseline.summary.meanReward = "1";
    },
    (r) => {
      r.results.baseline.summary.meanReward = null;
    },
    (r) => {
      r.results.baseline.summary.meanReward = 1e300;
    },
  ]) {
    const input = report();
    mutate(input);
    const result = await publication(t, { report: input });
    assert.match(result.body, /Report unavailable or invalid/);
    assert.doesNotMatch(result.body, /evil.example|resolved: 1/);
  }
});

test("execution success does not claim a task pass and unknown report fields are never rendered", async (t) => {
  const input = report();
  input.results.baseline.summary = { tasks: 1, attempts: 1, resolved: 0, meanReward: 0 };
  input.markdown = "@everyone <script>artifact-code</script>";
  input.results.baseline.error = "secret-output";
  const result = await publication(t, { report: input });
  assert.match(result.body, /\*\*success\*\*/);
  assert.match(result.body, /resolved: 0; mean reward: 0.000/);
  assert.match(result.body, /Execution success alone does not mean the task was resolved/);
  assert.doesNotMatch(result.body, /@everyone|artifact-code|secret-output/);
});

test("dispatch reports the dispatched checkout SHA without publishing a PR comment", async (t) => {
  const input = report();
  const dispatchSha = "b".repeat(40);
  input.manifest.arms.baseline.sourceRevision = dispatchSha;
  const result = await publication(t, { dispatch: true, summaryOnly: true, report: input });
  assert.deepEqual(result.calls, []);
  assert.match(result.summaries[0], new RegExp(`Tested head SHA:.*${dispatchSha}`));
  assert.match(result.summaries[0], /resolved: 1; mean reward: 1.000/);
  assert.deepEqual(result.warnings, []);
});

test("read-only benchmark reporting writes a summary artifact without calling GitHub", async (t) => {
  const result = await publication(t, { summaryOnly: true, missing: true, status: "failure" });
  assert.deepEqual(result.calls, []);
  assert.equal(await readFile(join(result.root, "summary.md"), "utf8"), result.summaries[0]);
  assert.match(result.summaries[0], /\*\*failure\*\*/);
});

test("public fixture resolves workspace packages and exposes staged extension dependencies", async () => {
  const fixture = new URL("../apps/fixtures/eve-code-bench/", import.meta.url);
  const pkg = JSON.parse(await readFile(new URL("package.json", fixture), "utf8"));
  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies.eve, "workspace:*");
  assert.equal(pkg.dependencies["eve-code"], "workspace:*");
  assert.equal(pkg.dependencies["@vercel/connect"], "catalog:");
  assert.equal(pkg.dependencies.zod, "catalog:");
  const mount = await readFile(new URL("agent/extensions/code.ts", fixture), "utf8");
  assert.match(mount, /import code from "eve-code"/);
  assert.match(mount, /export default code\(\{\}\)/);
  assert.match(
    await readFile(new URL("agent/agent.ts", fixture), "utf8"),
    /process\.env\.E0_MODEL/,
  );
});

test("package integration depends only on the build while root tests avoid concurrent dist cleanup", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const config = JSON.parse(
    await readFile(new URL("../packages/eve-code/turbo.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(config.tasks["test:integration"].dependsOn, ["eve#build"]);
  assert.equal(
    pkg.scripts["test:integration"],
    'turbo run test:integration --filter=eve && turbo run test:integration --filter="!eve"',
  );
});
