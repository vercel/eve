import assert from "node:assert/strict";
import test from "node:test";

import { mergeSnapshot, snapshotFromReport } from "./eve-code-docs-snapshot.mjs";

const score = (contender, resolved) => ({
  contender,
  attempts: 10,
  resolved,
  resolveRate: { estimate: resolved / 10, low: 0, high: 1 },
  costUsd: 1,
  costPerResolvedUsd: 1 / resolved,
  inputTokens: 100,
  cachedShare: 0.5,
  outputTokens: 10,
  latencyP50Ms: 1000,
  latencyP90Ms: 2000,
});

const result = (harness) => ({
  harness,
  trials: [{ finishedAt: "2026-09-29T00:00:00.000Z" }],
  provenance: { source: { revision: "abc" }, run: { url: `https://example.test/${harness}` } },
});

const report = (overrides = {}) => ({
  status: "comparable",
  manifest: {
    task: null,
    cohort: null,
    dataset: { name: "swe-lean", version: "v1" },
    model: "anthropic/claude-sonnet-5.5",
    modelVersion: { id: "anthropic/claude-sonnet-5.5", released: "2026-09-28" },
    attempts: 5,
    tasks: ["a", "b"],
  },
  comparison: {
    references: [{ harness: "opencode", entry: { publishedAt: "2026-09-30T00:00:00.000Z" } }],
    comparison: {
      compatible: true,
      complete: true,
      results: [result("eve-code"), result("opencode")],
      summary: { scores: [score("eve-code", 8), score("opencode", 7)] },
    },
  },
  ...overrides,
});

test("summarizes each harness with its own measurement time", () => {
  const { section } = snapshotFromReport(report());
  assert.equal(section.tasks, 2);
  assert.deepEqual(
    section.harnesses.map(({ harness, resolved, measuredAt }) => [harness, resolved, measuredAt]),
    [
      ["eve-code", 8, "2026-09-29T00:00:00.000Z"],
      ["opencode", 7, "2026-09-30T00:00:00.000Z"],
    ],
  );
});

test("never publishes an incomplete, partial, or eve-code-less run", () => {
  assert.match(snapshotFromReport(report({ status: "incomplete" })).skip, /incomplete/);
  const probe = report();
  probe.manifest.task = "a";
  assert.match(snapshotFromReport(probe).skip, /full-dataset/);
  const peerless = report();
  peerless.comparison.comparison.results = [result("opencode")];
  assert.match(snapshotFromReport(peerless).skip, /no eve-code/);
});

test("replaces only the measured dataset", () => {
  const existing = { schemaVersion: 1, datasets: { "deepswe-lean": { kept: true } } };
  const { section } = snapshotFromReport(report());
  const merged = mergeSnapshot(existing, section, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(merged.datasets).sort(), ["deepswe-lean", "swe-lean"]);
  assert.equal(merged.datasets["swe-lean"].generatedAt, "2026-10-01T00:00:00.000Z");
});
