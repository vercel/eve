import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { snapshotFromReport } from "../../../.github/scripts/eve-code-docs-snapshot.mjs";
import { loadTaskFromDir, parseTaskToml } from "./datasets.ts";
import { taskContainerEnvironment } from "./harnesses/container-sandbox.mjs";
import { renderEveCodeAppFiles } from "./harnesses/eve-code.ts";
import { buildReport, renderMarkdownReport } from "./report.ts";

async function readAllText(stream) {
  const reader = stream.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("container sandbox omits close() so concurrent handles never SIGKILL sibling commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "code-bench-sandbox-"));
  const storagePath = await mkdtemp(join(tmpdir(), "code-bench-storage-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(storagePath, { recursive: true, force: true });
  });

  const env = taskContainerEnvironment({ root });
  const ctx = { session: { id: "sess-concurrent-test" }, storagePath };
  const started = await env.start(ctx, undefined, { version: 1, files: [] });
  const resumed = await env.resume(ctx);

  assert.equal(started.connection.close, undefined);
  assert.equal(resumed.close, undefined);

  const longProc = await started.connection.spawn({
    command: "sleep 0.4; printf 'survived\\n'",
    workingDirectory: root,
    env: {},
  });
  const quickProc = await resumed.spawn({
    command: "printf 'quick\\n'",
    workingDirectory: root,
    env: {},
  });

  const quickExit = await quickProc.wait();
  assert.equal(quickExit.exitCode, 0);
  assert.equal((await readAllText(quickProc.stdout)).trim(), "quick");

  const longExit = await longProc.wait();
  assert.equal(longExit.exitCode, 0);
  assert.equal((await readAllText(longProc.stdout)).trim(), "survived");

  await env.onSessionEnd(ctx, started.state);
});

test("container sandbox supports stdin, per-command abort, and onSessionEnd cleanup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "code-bench-sandbox-stdin-"));
  const storagePath = await mkdtemp(join(tmpdir(), "code-bench-storage-stdin-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(storagePath, { recursive: true, force: true });
  });

  const env = taskContainerEnvironment({ root });
  const ctx = { session: { id: "sess-abort-test" }, storagePath };
  const { connection, state } = await env.start(ctx, undefined, { version: 1, files: [] });

  const echoProc = await connection.spawn({
    command: "cat",
    workingDirectory: root,
    env: {},
    stdin: true,
  });
  const writer = echoProc.stdin.getWriter();
  await writer.write(new TextEncoder().encode("hello-stdin\n"));
  await writer.close();
  assert.equal((await echoProc.wait()).exitCode, 0);
  assert.equal((await readAllText(echoProc.stdout)).trim(), "hello-stdin");

  const controller = new AbortController();
  const abortedProc = await connection.spawn({
    command: "sleep 30",
    workingDirectory: root,
    env: {},
    signal: controller.signal,
  });
  const survivorProc = await connection.spawn({
    command: "sleep 0.2; printf 'still-alive\\n'",
    workingDirectory: root,
    env: {},
  });
  controller.abort(new Error("stop one"));
  await assert.rejects(abortedProc.wait(), /stop one/u);
  assert.equal((await survivorProc.wait()).exitCode, 0);
  assert.equal((await readAllText(survivorProc.stdout)).trim(), "still-alive");

  const leftover = await connection.spawn({
    command: "sleep 30",
    workingDirectory: root,
    env: {},
  });
  await env.onSessionEnd(ctx, state);
  const leftoverExit = await leftover.wait();
  assert.notEqual(leftoverExit.exitCode, 0);
});

test("parseTaskToml and loadTaskFromDir apply DeepSWE timeout cap and neutral git identity", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "code-bench-task-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const sampleToml = `
schema_version = "1.3"
artifacts = ["/logs/artifacts/model.patch"]

[agent]
timeout_sec = 10800.0

[verifier]
environment_mode = "separate"
timeout_sec = 1800.0

[[verifier.collect]]
command = "git diff HEAD > /logs/artifacts/model.patch"
timeout_sec = 300.0

[environment]
docker_image = "example.com/task:v1"
cpus = 2
memory_mb = 8192

[environment.env]
`;
  const parsed = parseTaskToml(sampleToml);
  assert.deepEqual(parsed.artifacts, ["/logs/artifacts/model.patch"]);

  await writeFile(join(dir, "task.toml"), sampleToml);
  await writeFile(join(dir, "instruction.md"), "Implement feature X.\n");

  const task = await loadTaskFromDir("deepswe-lean", "sample-task", dir);
  assert.equal(task.agentTimeoutSec, 1200);
  assert.equal(task.separateVerifier, true);
  assert.equal(task.collectHooks.length, 1);
  assert.equal(task.env.GIT_AUTHOR_NAME, "code-bench");
  assert.equal(task.env.GIT_COMMITTER_EMAIL, "code-bench@localhost");
});

test("renderEveCodeAppFiles uses production token auth and stock eve/extensions/code without EVE_DEV", () => {
  const files = renderEveCodeAppFiles("high");
  assert.match(files["agent/extensions/code.ts"], /eve\/extensions\/code/u);
  assert.match(files["agent/channels/eve.ts"], /verifyHttpBasic/u);
  assert.doesNotMatch(files["agent/channels/eve.ts"], /localDev/u);
  assert.match(files["agent/tools/web_search.ts"], /disableTool/u);
  assert.match(files["agent/tools/web_fetch.ts"], /disableTool/u);
});

test("buildReport emits report.json compatible with eve-code-docs-snapshot.mjs", () => {
  const tasks = [
    {
      name: "task-a",
      dataset: "deepswe-lean",
      dir: "/tmp/a",
      instruction: "A",
      dockerImage: "img",
      agentTimeoutSec: 1200,
      verifierTimeoutSec: 600,
      separateVerifier: true,
      collectHooks: [],
      artifacts: [],
      env: {},
      cpus: 2,
      memoryMb: 4096,
    },
    {
      name: "task-b",
      dataset: "deepswe-lean",
      dir: "/tmp/b",
      instruction: "B",
      dockerImage: "img",
      agentTimeoutSec: 1200,
      verifierTimeoutSec: 600,
      separateVerifier: true,
      collectHooks: [],
      artifacts: [],
      env: {},
      cpus: 2,
      memoryMb: 4096,
    },
  ];
  const makeTrial = (harness, task, reward, durationMs) => ({
    task,
    attempt: 1,
    harness,
    model: "openai/gpt-6.2-sol",
    reward,
    agent: { status: "completed", exitCode: 0, durationMs },
    verifier: { status: "completed", exitCode: 0, durationMs: 5000 },
    usage: { inputTokens: 100_000, outputTokens: 2_000, cachedTokens: 80_000, costUsd: 0.25 },
    overhead: { firstStepInputTokens: 2000, modelSteps: 10, toolCalls: { bash: 5 } },
    startedAt: "2026-11-27T00:00:00.000Z",
    finishedAt: "2026-11-27T00:02:00.000Z",
  });
  const trials = [
    makeTrial("eve-code", "task-a", 1, 120_000),
    makeTrial("eve-code", "task-b", 1, 180_000),
    makeTrial("pi", "task-a", 1, 140_000),
    makeTrial("pi", "task-b", 0, 200_000),
  ];

  const report = buildReport({
    options: {
      dataset: "deepswe-lean",
      harnesses: ["eve-code", "pi"],
      model: "openai/gpt-6.2-sol",
      reasoning: "high",
      attempts: 1,
      concurrency: 2,
      execution: "local",
      outputDir: "/tmp/out",
      sourceSha: "1234567890abcdef1234567890abcdef12345678",
      runUrl: "https://github.com/vercel/eve/actions/runs/999",
    },
    tasks,
    trials,
    versions: { "eve-code": "1234567", pi: "1.7.0" },
  });

  assert.equal(report.status, "comparable");
  const snapshot = snapshotFromReport(report);
  assert.equal(snapshot.skip, undefined);
  assert.equal(snapshot.section.dataset.name, "deepswe-lean");
  assert.equal(snapshot.section.harnesses.length, 2);
  assert.equal(snapshot.section.harnesses[0].harness, "eve-code");
  assert.equal(snapshot.section.harnesses[0].resolved, 2);

  const { reportMd, commentMd } = renderMarkdownReport(report);
  assert.match(reportMd, /eve-code/u);
  assert.match(commentMd, /<!-- eve-code-bench:deepswe-lean:openai\/gpt-6\.2-sol -->/u);
});
