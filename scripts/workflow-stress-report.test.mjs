import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectWorkflowStressMetrics,
  createWorkflowStressReport,
  renderWorkflowStressMarkdown,
} from "./workflow-stress-report.mjs";

const PREFIX = "EVE_WORKFLOW_STRESS_METRIC=";

test("builds a report from eval artifact metrics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-workflow-stress-report-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const artifactDirectory = join(root, "2026-08-31", "evals");
  await mkdir(artifactDirectory, { recursive: true });

  await writeArtifact(artifactDirectory, "sequential.json", {
    fixture: "agent-workflow-stress",
    samples: Array.from({ length: 100 }, (_, index) => ({
      durationMs: 1_000 + index * 10,
      turnNumber: index + 1,
    })),
    scenario: "sequential",
    schemaVersion: 1,
    unit: "milliseconds",
  });
  await writeArtifact(artifactDirectory, "concurrent.json", {
    batches: [
      {
        batchDurationMs: 1_200,
        samples: [
          { durationMs: 1_000, sessionNumber: 1 },
          { durationMs: 1_200, sessionNumber: 2 },
        ],
        turnNumber: 1,
      },
      {
        batchDurationMs: 900,
        samples: [
          { durationMs: 800, sessionNumber: 1 },
          { durationMs: 900, sessionNumber: 2 },
        ],
        turnNumber: 2,
      },
    ],
    fixture: "agent-workflow-stress",
    scenario: "concurrent",
    schemaVersion: 1,
    unit: "milliseconds",
  });

  const metrics = await collectWorkflowStressMetrics(root);
  const report = createWorkflowStressReport(metrics, { sha: "abc123" });
  const markdown = renderWorkflowStressMarkdown(report);

  assert.equal(report.scenarios.sequential.allTurns.count, 100);
  assert.equal(report.scenarios.sequential.allTurns.meanMs, 1_495);
  assert.equal(report.scenarios.sequential.sequentialTurnOrderSlopeMsPerTurn, 10);
  assert.equal(report.scenarios.concurrent.firstTurns.p50Ms, 1_100);
  assert.match(markdown, /Sequential warm turn-order slope: \*\*10\.00 ms\/turn\*\*/);
  assert.match(markdown, /sha=`abc123`/);
});

test("rejects artifacts without both stress scenarios", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-workflow-stress-report-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeArtifact(join(root, "2026-08-31", "evals"), "sequential.json", {
    fixture: "agent-workflow-stress",
    samples: [{ durationMs: 1_000, turnNumber: 1 }],
    scenario: "sequential",
    schemaVersion: 1,
    unit: "milliseconds",
  });

  await assert.rejects(collectWorkflowStressMetrics(root), /missing the concurrent scenario/);
});

test("does not combine scenarios from different eval runs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "eve-workflow-stress-report-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const olderRun = join(root, "2026-08-30", "evals");
  const latestRun = join(root, "2026-08-31", "evals");

  await writeArtifact(olderRun, "sequential.json", sequentialMetric());
  await writeArtifact(olderRun, "concurrent.json", concurrentMetric());
  await writeArtifact(latestRun, "sequential.json", sequentialMetric());

  await assert.rejects(
    collectWorkflowStressMetrics(root),
    /2026-08-31.*missing the concurrent scenario/,
  );
});

async function writeArtifact(directory, name, metric) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, name),
    JSON.stringify({ result: { logs: [`${PREFIX}${JSON.stringify(metric)}`] } }),
  );
}

function sequentialMetric() {
  return {
    fixture: "agent-workflow-stress",
    samples: [{ durationMs: 1_000, turnNumber: 1 }],
    scenario: "sequential",
    schemaVersion: 1,
    unit: "milliseconds",
  };
}

function concurrentMetric() {
  return {
    batches: [
      {
        batchDurationMs: 1_000,
        samples: [{ durationMs: 1_000, sessionNumber: 1 }],
        turnNumber: 1,
      },
      {
        batchDurationMs: 900,
        samples: [{ durationMs: 900, sessionNumber: 1 }],
        turnNumber: 2,
      },
    ],
    fixture: "agent-workflow-stress",
    scenario: "concurrent",
    schemaVersion: 1,
    unit: "milliseconds",
  };
}
