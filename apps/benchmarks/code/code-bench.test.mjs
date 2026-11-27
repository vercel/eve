import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { snapshotFromReport } from "../../../.github/scripts/eve-code-docs-snapshot.mjs";
import { loadTaskFromDir } from "./datasets.ts";
import { parseRewardText } from "./docker.ts";
import { summarizeEvents } from "./harnesses/eve-runner.mjs";
import {
  buildOpencodeConfig,
  parseFxOutput,
  parseOpencodeEvents,
  parsePiJsonl,
} from "./harnesses/peer-runner.mjs";
import { buildReport, renderMarkdownReport } from "./report.ts";

test("loadTaskFromDir applies DeepSWE timeout cap, neutral git identity, and collect hooks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "code-bench-task-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(
    join(dir, "task.toml"),
    `
schema_version = "1.3"
artifacts = [
  "/logs/artifacts/model.patch",
]

[agent]
timeout_sec = 3600.0

[verifier]
environment_mode = "separate"
timeout_sec = 1800.0

[[verifier.collect]]
command = "git diff HEAD > /logs/artifacts/model.patch"
timeout_sec = 300.0

[environment]
docker_image = "example/img:v1"
cpus = 2
memory_mb = 8192
`,
  );

  const task = await loadTaskFromDir("deepswe-lean", dir);
  assert.equal(task.agentTimeoutSec, 1200);
  assert.equal(task.verifierTimeoutSec, 1800);
  assert.equal(task.separateVerifier, true);
  assert.equal(task.dockerImage, "example/img:v1");
  assert.equal(task.env.GIT_AUTHOR_NAME, "eve-bench");
  assert.equal(task.collectHooks.length, 1);
  assert.equal(task.collectHooks[0]?.command, "git diff HEAD > /logs/artifacts/model.patch");
});

test("parseRewardText rejects DeepSWE -1 crash sentinels, empty files, and out-of-range values", () => {
  assert.deepEqual(parseRewardText("1\n"), { reward: 1 });
  assert.deepEqual(parseRewardText("0"), { reward: 0 });
  assert.deepEqual(parseRewardText("0.5"), { reward: 0.5 });

  const crash = parseRewardText("-1\n");
  assert.equal(crash.reward, null);
  assert.match(crash.error ?? "", /crash sentinel/u);

  const empty = parseRewardText("   \n");
  assert.equal(empty.reward, null);
  assert.match(empty.error ?? "", /empty/u);

  const outOfRange = parseRewardText("2");
  assert.equal(outOfRange.reward, null);
  assert.match(outOfRange.error ?? "", /out-of-range/u);
});

test("peer-runner handles OpenCode gpt-6.2-sol config, reasoning tokens, pi error masking, and fx subagents", () => {
  const ocCfg = buildOpencodeConfig("openai/gpt-6.2-sol");
  assert.deepEqual(ocCfg.provider.vercel.models["openai/gpt-6.2-sol"], {
    name: "openai/gpt-6.2-sol",
    reasoning: true,
    limit: { context: 1_050_000, output: 128_000 },
  });

  const ocParsed = parseOpencodeEvents(
    [
      JSON.stringify({ type: "tool_use", sessionID: "s1" }),
      JSON.stringify({
        type: "step_finish",
        sessionID: "s1",
        part: {
          cost: 0.05,
          tokens: { input: 1000, output: 200, reasoning: 300, cache: { read: 400, write: 100 } },
        },
      }),
    ].join("\n"),
    [{ info: { role: "assistant" } }],
  );
  assert.equal(ocParsed.inputTokens, 1500);
  assert.equal(ocParsed.outputTokens, 500);
  assert.equal(ocParsed.cachedTokens, 400);
  assert.equal(ocParsed.modelSteps, 1);
  assert.equal(ocParsed.costUsd, 0.05);

  const piFailed = parsePiJsonl(
    [
      JSON.stringify({ type: "tool_execution_start" }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "429 rate limited",
          usage: { input: 500, output: 10, cacheRead: 100, cacheWrite: 0 },
        },
      }),
    ].join("\n"),
  );
  assert.equal(piFailed.failedByStopReason, true);
  assert.equal(piFailed.lastAssistantError, "429 rate limited");
  assert.equal(piFailed.inputTokens, 600);
  assert.equal(piFailed.toolCalls, 1);

  const fxParsed = parseFxOutput(
    JSON.stringify({
      steps: 4,
      tool_calls: [{ name: "shell" }, { name: "read_file" }],
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 200 },
      subagents: [{ usage: { input_tokens: 500, output_tokens: 50, cache_read_tokens: 100 } }],
    }),
  );
  assert.equal(fxParsed.inputTokens, 1500);
  assert.equal(fxParsed.outputTokens, 150);
  assert.equal(fxParsed.cachedTokens, 300);
  assert.equal(fxParsed.modelSteps, 4);
  assert.equal(fxParsed.toolCalls, 2);
});

test("summarizeEvents rolls up model and delegated-late usage.recorded events and handles delivery outcomes", () => {
  const okSummary = summarizeEvents([
    { type: "model.settled", data: {} },
    { type: "model.settled", data: {} },
    { type: "call.requested", data: { capability: { name: "bash" } } },
    {
      type: "usage.recorded",
      data: {
        kind: "model",
        usage: { inputTokens: 2000, outputTokens: 100, cacheReadTokens: 500, costUsd: 0.02 },
      },
    },
    {
      type: "usage.recorded",
      data: {
        kind: "delegated-late",
        usage: { inputTokens: 300, outputTokens: 20, cacheReadTokens: 50, costUsd: 0.01 },
      },
    },
    { type: "turn.settled", data: { outcome: "completed" } },
    { type: "delivery.settled", data: { outcome: "handled" } },
  ]);
  assert.deepEqual(okSummary.usage, {
    inputTokens: 2300,
    outputTokens: 120,
    cachedTokens: 550,
    costUsd: 0.03,
  });
  assert.equal(okSummary.overhead.firstStepInputTokens, 2000);
  assert.equal(okSummary.overhead.modelSteps, 2);
  assert.deepEqual(okSummary.overhead.toolCalls, { bash: 1 });
  assert.equal(okSummary.failure, undefined);

  const failedSummary = summarizeEvents([
    { type: "delivery.settled", data: { outcome: "refused", reason: "rate limit" } },
  ]);
  assert.equal(failedSummary.failure?.message, "rate limit");
});

test("buildReport emits report.json compatible with eve-code-docs-snapshot.mjs", () => {
  const tasks = [{ name: "task-a" }, { name: "task-b" }];

  const trials = [
    {
      task: "task-a",
      attempt: 1,
      harness: "eve-code",
      model: "anthropic/claude-sonnet-5.5",
      reward: 1,
      agent: { status: "completed", exitCode: 0, durationMs: 25_000 },
      verifier: { status: "completed", exitCode: 0, durationMs: 3_000 },
      usage: { inputTokens: 120_000, outputTokens: 4_000, cachedTokens: 90_000 },
      overhead: { firstStepInputTokens: 3_800, modelSteps: 8, toolCalls: 12 },
      startedAt: "2026-11-27T00:00:00Z",
      finishedAt: "2026-11-27T00:00:28Z",
    },
    {
      task: "task-b",
      attempt: 1,
      harness: "eve-code",
      model: "anthropic/claude-sonnet-5.5",
      reward: 0,
      agent: { status: "completed", exitCode: 0, durationMs: 35_000 },
      verifier: { status: "completed", exitCode: 0, durationMs: 4_000 },
      usage: { inputTokens: 150_000, outputTokens: 5_000, cachedTokens: 100_000 },
      overhead: { firstStepInputTokens: 3_900, modelSteps: 10, toolCalls: 15 },
      startedAt: "2026-11-27T00:00:00Z",
      finishedAt: "2026-11-27T00:00:39Z",
    },
    {
      task: "task-a",
      attempt: 1,
      harness: "pi",
      model: "anthropic/claude-sonnet-5.5",
      reward: 1,
      agent: { status: "completed", exitCode: 0, durationMs: 30_000 },
      verifier: { status: "completed", exitCode: 0, durationMs: 3_000 },
      usage: { inputTokens: 130_000, outputTokens: 4_500, cachedTokens: 80_000 },
      overhead: { firstStepInputTokens: 4_100, modelSteps: 9, toolCalls: 14 },
      startedAt: "2026-11-27T00:00:00Z",
      finishedAt: "2026-11-27T00:00:33Z",
    },
    {
      task: "task-b",
      attempt: 1,
      harness: "pi",
      model: "anthropic/claude-sonnet-5.5",
      reward: 1,
      agent: { status: "completed", exitCode: 0, durationMs: 40_000 },
      verifier: { status: "completed", exitCode: 0, durationMs: 4_000 },
      usage: { inputTokens: 140_000, outputTokens: 4_800, cachedTokens: 90_000 },
      overhead: { firstStepInputTokens: 4_200, modelSteps: 11, toolCalls: 16 },
      startedAt: "2026-11-27T00:00:00Z",
      finishedAt: "2026-11-27T00:00:44Z",
    },
  ];

  const report = buildReport({
    options: {
      dataset: "deepswe-lean",
      harnesses: ["eve-code", "pi"],
      model: "anthropic/claude-sonnet-5.5",
      reasoning: "high",
      attempts: 1,
      concurrency: 2,
      execution: "local",
      outputDir: "/tmp/out",
      sourceSha: "abc1234567890",
    },
    tasks,
    trials,
    versions: { "eve-code": "abc1234", pi: "1.7.0" },
  });

  assert.equal(report.status, "comparable");
  const snapshot = snapshotFromReport(report);
  assert.equal(snapshot.skip, undefined);
  assert.equal(snapshot.section.dataset.name, "deepswe-lean");
  assert.equal(snapshot.section.harnesses.length, 2);

  const { reportMd, commentMd } = renderMarkdownReport(report);
  assert.match(reportMd, /`eve-code`/u);
  assert.match(commentMd, /<!-- eve-code-bench:deepswe-lean:anthropic\/claude-sonnet-5\.5 -->/u);
  assert.match(commentMd, /`pi`/u);
});
