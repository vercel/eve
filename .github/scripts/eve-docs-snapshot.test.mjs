import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { mergeSnapshot, modelFamily, snapshotFromReport } from "./eve-docs-snapshot.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = new URL("./eve-docs-snapshot.mjs", import.meta.url).pathname;

const score = (contender, resolved) => ({
  contender,
  attempts: 6,
  resolved,
  resolveRate: { estimate: resolved / 6, low: 0, high: 1 },
  costUsd: 1.5,
  medianCostUsd: 0.25,
  costPerResolvedUsd: 1.5 / resolved,
  inputTokens: 1000,
  cachedShare: 0.9,
  outputTokens: 100,
  latencyP50Ms: 1000,
  latencyP90Ms: 2000,
});

const result = (harness, contender) => ({
  harness,
  ...(contender ? { contender } : {}),
  trials: [{ finishedAt: "2026-09-29T00:00:00.000Z" }],
  provenance: {
    harness:
      harness === "eve"
        ? { eve: { kind: "installed", version: "1.5.0" } }
        : { opencodeVersion: "1.18.30" },
    harnessSettings: { reasoning: "high" },
    source: { revision: "a7b0fb2b5c" },
    run: { url: `https://example.test/${harness}` },
  },
});

const report = (overrides = {}) => ({
  status: "comparable",
  manifest: {
    task: null,
    cohort: null,
    dataset: { name: "deepswe-lean", version: "v1", commit: "0b9fabbb" },
    model: "anthropic/claude-sonnet-5.5",
    modelVersion: {
      id: "anthropic/claude-sonnet-5.5",
      released: "2026-09-28",
      extraSecret: "drop",
    },
    attempts: 3,
    tasks: ["task-a", "task-b"],
  },
  overhead: {
    eve: {
      firstStepInputTokens: { median: 3100 },
      modelSteps: { median: 18, total: 108 },
      toolCalls: { median: 20, total: 120, byTool: { bash: 100, read_file: 20 } },
    },
    opencode: {
      firstStepInputTokens: { median: 9500 },
      modelSteps: { median: 22, total: 132 },
      toolCalls: { median: 24, total: 144, byTool: { shell: 120, read: 24 } },
    },
  },
  comparison: {
    references: [{ harness: "opencode", entry: { publishedAt: "2026-09-30T00:00:00.000Z" } }],
    comparison: {
      compatible: true,
      complete: true,
      results: [result("eve", "bench-agent"), result("opencode")],
      summary: {
        baseline: "bench-agent",
        contenders: ["bench-agent", "opencode"],
        scores: [score("bench-agent", 5), score("opencode", 4)],
        tasks: [
          {
            task: "task-a",
            cells: [
              {
                resolved: 3,
                attempts: 3,
                latencyMs: 1100.4,
                inputTokens: 500.2,
                outputTokens: 50.6,
              },
              {
                resolved: 2,
                attempts: 3,
                latencyMs: 1300.2,
                inputTokens: 600.8,
                outputTokens: 60.1,
              },
            ],
          },
          {
            task: "task-b",
            cells: [
              { resolved: 2, attempts: 3, latencyMs: 1500, inputTokens: 500, outputTokens: 50 },
              { resolved: 2, attempts: 3, latencyMs: 1700, inputTokens: 700, outputTokens: 70 },
            ],
          },
        ],
        effects: [
          {
            contender: "opencode",
            metric: "latencyMs",
            tasks: 2,
            better: 0,
            worse: 2,
            effect: { estimate: 1.2, low: 1.1, high: 1.3 },
            verdict: "worse",
          },
        ],
      },
    },
  },
  ...overrides,
});

test("extracts per-harness metrics, pass^k, overhead, effects, task matrix, and safe model fields", () => {
  const { section } = snapshotFromReport(report());
  assert.equal(section.family, "anthropic");
  assert.equal(section.tasks, 2);
  assert.equal(section.reasoning, "high");
  assert.deepEqual(section.model, { id: "anthropic/claude-sonnet-5.5", released: "2026-09-28" });
  assert.deepEqual(
    section.harnesses.map(
      ({ harness, version, resolved, passAllTasks, passAllRate, measuredAt }) => [
        harness,
        version,
        resolved,
        passAllTasks,
        passAllRate,
        measuredAt,
      ],
    ),
    [
      ["eve", "a7b0fb2", 5, 1, 0.5, "2026-09-29T00:00:00.000Z"],
      ["opencode", "1.18.30", 4, 0, 0, "2026-09-30T00:00:00.000Z"],
    ],
  );
  assert.deepEqual(section.harnesses[0].overhead.topTools, [
    { name: "bash", count: 100 },
    { name: "read_file", count: 20 },
  ]);
  assert.equal(section.harnesses[0].effectsVsEve, null);
  assert.equal(section.harnesses[1].effectsVsEve.latencyMs.verdict, "worse");
  assert.equal(section.taskMatrix[0].cells.eve.resolved, 3);
  assert.equal(section.taskMatrix[0].cells.opencode.latencyMs, 1300);
});

test("omits effectsVsEve when the comparison baseline is not eve", () => {
  const nonEveBaseline = report();
  nonEveBaseline.comparison.comparison.summary.baseline = "opencode";
  const { section } = snapshotFromReport(nonEveBaseline);
  assert.equal(section.harnesses[1].effectsVsEve, null);
});

test("never publishes an incomplete, partial, or eve-less run", () => {
  assert.match(snapshotFromReport(report({ status: "incomplete" })).skip, /incomplete/);
  const probe = report();
  probe.manifest.task = "task-a";
  assert.match(snapshotFromReport(probe).skip, /full-dataset/);
  const peerless = report();
  peerless.comparison.comparison.results = [result("opencode")];
  assert.match(snapshotFromReport(peerless).skip, /no eve/);
  assert.equal(modelFamily(""), "unknown");
});

test("keeps dataset version, attempts, tasks, and reasoning isolated per model family", () => {
  const anthropic = snapshotFromReport(report()).section;
  const openaiReport = report();
  openaiReport.manifest.dataset = { name: "deepswe-lean", version: "v2" };
  openaiReport.manifest.attempts = 5;
  openaiReport.manifest.tasks = ["a", "b", "c"];
  openaiReport.manifest.model = "openai/gpt-6.2-sol";
  openaiReport.manifest.modelVersion = { id: "openai/gpt-6.2-sol", released: "2026-11-17" };
  openaiReport.comparison.comparison.results[0].provenance.harnessSettings.reasoning = "medium";
  const openai = snapshotFromReport(openaiReport).section;

  const first = mergeSnapshot({}, anthropic, "2026-10-01T00:00:00.000Z");
  const both = mergeSnapshot(first, openai, "2026-10-02T00:00:00.000Z");
  assert.equal(both.schemaVersion, 2);
  assert.equal(both.datasets["deepswe-lean"].models.anthropic.dataset.version, "v1");
  assert.equal(both.datasets["deepswe-lean"].models.anthropic.dataset.commit, "0b9fabbb");
  assert.equal(both.datasets["deepswe-lean"].models.anthropic.attempts, 3);
  assert.equal(both.datasets["deepswe-lean"].models.anthropic.tasks, 2);
  assert.equal(both.datasets["deepswe-lean"].models.anthropic.reasoning, "high");

  assert.equal(both.datasets["deepswe-lean"].models.openai.dataset.version, "v2");
  assert.equal(both.datasets["deepswe-lean"].models.openai.attempts, 5);
  assert.equal(both.datasets["deepswe-lean"].models.openai.tasks, 3);
  assert.equal(both.datasets["deepswe-lean"].models.openai.reasoning, "medium");
});

test("upgrades v1 snapshots in place and backfills v2 nullable fields", () => {
  const v1Existing = {
    schemaVersion: 1,
    datasets: {
      "deepswe-lean": {
        dataset: { name: "deepswe-lean", version: "v1" },
        model: { id: "anthropic/claude-sonnet-5.5" },
        attempts: 3,
        tasks: 12,
        generatedAt: "2026-09-01T00:00:00.000Z",
        harnesses: [
          {
            harness: "eve",
            version: "abc1234",
            resolved: 26,
            attempts: 36,
            resolveRate: { estimate: 26 / 36, low: 0.5, high: 0.9 },
            costUsd: 14.9,
            costPerResolvedUsd: 0.57,
            inputTokens: 23_000_000,
            outputTokens: 820_000,
            cachedShare: 0.92,
            latencyP50Ms: 246_000,
            latencyP90Ms: 428_000,
            source: "abc1234",
            runUrl: "https://example.test/old",
            measuredAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      },
    },
  };
  const openaiReport = report();
  openaiReport.manifest.model = "openai/gpt-6.2-sol";
  openaiReport.manifest.modelVersion = { id: "openai/gpt-6.2-sol" };
  const openai = snapshotFromReport(openaiReport).section;

  const upgraded = mergeSnapshot(v1Existing, openai, "2026-10-02T00:00:00.000Z");
  const migratedAnthropic = upgraded.datasets["deepswe-lean"].models.anthropic;
  assert.equal(migratedAnthropic.dataset.version, "v1");
  assert.equal(migratedAnthropic.attempts, 3);
  assert.equal(migratedAnthropic.harnesses[0].passAllTasks, null);
  assert.equal(migratedAnthropic.harnesses[0].passAllRate, null);
  assert.equal(migratedAnthropic.harnesses[0].overhead, null);
  assert.equal(migratedAnthropic.harnesses[0].effectsVsEve, null);
});

test("rerunning an unchanged report keeps the snapshot byte-identical and CLI reports only changed families", async () => {
  const { section } = snapshotFromReport(report());
  const written = (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;
  const first = written(mergeSnapshot({}, section, "2026-10-01T00:00:00.000Z"));
  const again = mergeSnapshot(JSON.parse(first), section, "2026-10-08T00:00:00.000Z");
  assert.equal(written(again), first);

  const dir = await mkdtemp(join(tmpdir(), "eve-snapshot-test-"));
  try {
    const snapPath = join(dir, "snapshot.json");
    const anthropicPath = join(dir, "anthropic.json");
    const skippedPath = join(dir, "skipped.json");
    const openaiPath = join(dir, "openai.json");
    const updatedPath = join(dir, "updated.txt");

    await writeFile(snapPath, first);
    await writeFile(anthropicPath, JSON.stringify(report()));
    await writeFile(skippedPath, JSON.stringify(report({ status: "incomplete" })));
    const oai = report();
    oai.manifest.model = "openai/gpt-6.2-sol";
    oai.manifest.modelVersion = { id: "openai/gpt-6.2-sol" };
    await writeFile(openaiPath, JSON.stringify(oai));

    await execFileAsync(process.execPath, [
      SCRIPT_PATH,
      "--updated-file",
      updatedPath,
      anthropicPath,
      skippedPath,
      openaiPath,
      snapPath,
    ]);
    const updatedList = (await readFile(updatedPath, "utf8")).trim().split("\n").filter(Boolean);
    assert.deepEqual(updatedList, ["openai"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
