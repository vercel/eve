import assert from "node:assert/strict";
import test from "node:test";

import { mergeSnapshot, snapshotFromReport } from "./eve-docs-snapshot.mjs";

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

const result = (harness, contender) => ({
  harness,
  ...(contender ? { contender } : {}),
  trials: [{ finishedAt: "2026-09-29T00:00:00.000Z" }],
  provenance: {
    harness:
      harness === "eve"
        ? { eve: { kind: "installed", version: "1.5.0" } }
        : { opencodeVersion: "1.18.30" },
    source: { revision: "a7b0fb2b5c" },
    run: { url: `https://example.test/${harness}` },
  },
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
      results: [result("eve", "bench-agent"), result("opencode")],
      summary: { scores: [score("bench-agent", 8), score("opencode", 7)] },
    },
  },
  ...overrides,
});

test("summarizes each harness with its own measurement time", () => {
  const { section } = snapshotFromReport(report());
  assert.equal(section.tasks, 2);
  assert.deepEqual(
    section.harnesses.map(({ harness, version, resolved, measuredAt }) => [
      harness,
      version,
      resolved,
      measuredAt,
    ]),
    [
      ["eve", "a7b0fb2", 8, "2026-09-29T00:00:00.000Z"],
      ["opencode", "1.18.30", 7, "2026-09-30T00:00:00.000Z"],
    ],
  );
});

test("never publishes an incomplete, partial, or eve-less run", () => {
  assert.match(snapshotFromReport(report({ status: "incomplete" })).skip, /incomplete/);
  const probe = report();
  probe.manifest.task = "a";
  assert.match(snapshotFromReport(probe).skip, /full-dataset/);
  const peerless = report();
  peerless.comparison.comparison.results = [result("opencode")];
  assert.match(snapshotFromReport(peerless).skip, /no eve/);
});

test("replaces only the measured dataset", () => {
  const existing = { schemaVersion: 1, datasets: { "deepswe-lean": { kept: true } } };
  const { section } = snapshotFromReport(report());
  const merged = mergeSnapshot(existing, section, "2026-10-01T00:00:00.000Z");
  assert.deepEqual(Object.keys(merged.datasets).sort(), ["deepswe-lean", "swe-lean"]);
  assert.equal(merged.datasets["swe-lean"].generatedAt, "2026-10-01T00:00:00.000Z");
});

test("rerunning an unchanged report keeps the snapshot byte-identical", () => {
  const { section } = snapshotFromReport(report());
  const written = (snapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;
  const first = written(mergeSnapshot({}, section, "2026-10-01T00:00:00.000Z"));
  const again = mergeSnapshot(JSON.parse(first), section, "2026-10-08T00:00:00.000Z");
  assert.equal(written(again), first);

  const changed = snapshotFromReport(report()).section;
  changed.harnesses[0].resolved = 9;
  const updated = mergeSnapshot(JSON.parse(first), changed, "2026-10-08T00:00:00.000Z");
  assert.equal(updated.datasets["swe-lean"].generatedAt, "2026-10-08T00:00:00.000Z");
});
