import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const PERFORMANCE_LOG_PREFIX = "EVE_WORKFLOW_STRESS_METRIC=";
const REQUIRED_SCENARIOS = ["concurrent", "sequential"];

export async function collectWorkflowStressMetrics(artifactsRoot) {
  const artifactPaths = (await findJsonFiles(artifactsRoot)).sort();
  const metricsByRun = new Map();

  for (const artifactPath of artifactPaths) {
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    const logs = artifact?.result?.logs;

    if (!Array.isArray(logs)) {
      continue;
    }

    for (const log of logs) {
      if (typeof log !== "string") {
        continue;
      }

      const markerIndex = log.indexOf(PERFORMANCE_LOG_PREFIX);

      if (markerIndex === -1) {
        continue;
      }

      const metric = JSON.parse(log.slice(markerIndex + PERFORMANCE_LOG_PREFIX.length));
      validateMetric(metric, artifactPath);
      const runDirectory = findEvalRunDirectory(artifactsRoot, artifactPath);
      const metricsByScenario = metricsByRun.get(runDirectory) ?? new Map();
      metricsByScenario.set(metric.scenario, { artifactPath, metric });
      metricsByRun.set(runDirectory, metricsByScenario);
    }
  }

  const latestRun = [...metricsByRun.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .at(-1);

  if (latestRun === undefined) {
    throw new Error(`Missing Workflow stress metrics under ${artifactsRoot}`);
  }

  const [runDirectory, metricsByScenario] = latestRun;

  for (const scenario of REQUIRED_SCENARIOS) {
    if (!metricsByScenario.has(scenario)) {
      throw new Error(
        `Latest Workflow stress metric run ${runDirectory} is missing the ${scenario} scenario`,
      );
    }
  }

  return {
    runDirectory,
    ...Object.fromEntries(
      [...metricsByScenario.entries()].map(([scenario, entry]) => [scenario, entry]),
    ),
  };
}

export function createWorkflowStressReport(metrics, metadata = {}) {
  const sequentialSamples = metrics.sequential.metric.samples;
  const firstConcurrentBatch = metrics.concurrent.metric.batches.find(
    (batch) => batch.turnNumber === 1,
  );
  const secondConcurrentBatch = metrics.concurrent.metric.batches.find(
    (batch) => batch.turnNumber === 2,
  );

  if (firstConcurrentBatch === undefined || secondConcurrentBatch === undefined) {
    throw new Error("Concurrent Workflow stress metric must include turn 1 and turn 2 batches");
  }

  return {
    generatedAt: new Date().toISOString(),
    metadata,
    schemaVersion: 1,
    scenarios: {
      concurrent: {
        firstTurns: summarizeSamples(firstConcurrentBatch.samples),
        firstTurnsBatchDurationMs: firstConcurrentBatch.batchDurationMs,
        secondTurns: summarizeSamples(secondConcurrentBatch.samples),
        secondTurnsBatchDurationMs: secondConcurrentBatch.batchDurationMs,
      },
      sequential: {
        allTurns: summarizeSamples(sequentialSamples),
        coldTurn: summarizeSamples(sequentialSamples.slice(0, 1)),
        firstTenWarmTurns: summarizeSamples(sequentialSamples.slice(1, 11)),
        sequentialTurnOrderSlopeMsPerTurn: calculateLinearSlope(
          sequentialSamples.slice(1).map((sample) => [sample.turnNumber, sample.durationMs]),
        ),
        lastTenTurns: summarizeSamples(sequentialSamples.slice(-10)),
        warmTurns: summarizeSamples(sequentialSamples.slice(1)),
      },
    },
    sources: {
      concurrent: metrics.concurrent.artifactPath,
      runDirectory: metrics.runDirectory,
      sequential: metrics.sequential.artifactPath,
    },
  };
}

export function renderWorkflowStressMarkdown(report) {
  const sequential = report.scenarios.sequential;
  const concurrent = report.scenarios.concurrent;
  const rows = [
    ["Sequential, all turns", sequential.allTurns],
    ["Sequential, first/cold turn", sequential.coldTurn],
    ["Sequential, warm turns 2–100", sequential.warmTurns],
    ["Sequential, first 10 warm turns (2–11)", sequential.firstTenWarmTurns],
    ["Sequential, turns 91–100", sequential.lastTenTurns],
    ["Concurrent, first turn", concurrent.firstTurns],
    ["Concurrent, second turn", concurrent.secondTurns],
  ];
  const lines = [
    "## Workflow stress performance",
    "",
    "> Informational hosted measurement. Compare paired base/head runs before attributing a change; this report is not a performance gate.",
    "",
    "| Scenario | Samples | Mean | p50 | p90 | p95 | Min | Max |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(([label, summary]) =>
      [
        `| ${label}`,
        summary.count,
        formatDuration(summary.meanMs),
        formatDuration(summary.p50Ms),
        formatDuration(summary.p90Ms),
        formatDuration(summary.p95Ms),
        formatDuration(summary.minMs),
        `${formatDuration(summary.maxMs)} |`,
      ].join(" | "),
    ),
    "",
    `Sequential warm turn-order slope: **${sequential.sequentialTurnOrderSlopeMsPerTurn.toFixed(2)} ms/turn** (history-correlated, but also time-order confounded).`,
    `Concurrent batch wall time: **${formatDuration(concurrent.firstTurnsBatchDurationMs)}** first turns, **${formatDuration(concurrent.secondTurnsBatchDurationMs)}** second turns.`,
  ];

  const metadata = Object.entries(report.metadata).filter(([, value]) => value !== undefined);

  if (metadata.length > 0) {
    lines.push(
      "",
      `Run: ${metadata.map(([key, value]) => `${key}=\`${String(value)}\``).join(", ")}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function summarizeSamples(samples) {
  const values = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);

  if (values.length === 0) {
    throw new Error("Cannot summarize an empty Workflow stress sample set");
  }

  return {
    count: values.length,
    maxMs: values.at(-1),
    meanMs: values.reduce((total, value) => total + value, 0) / values.length,
    minMs: values[0],
    p50Ms: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    p95Ms: percentile(values, 0.95),
  };
}

function percentile(sortedValues, probability) {
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sortedValues[lowerIndex];
  const upperValue = sortedValues[upperIndex];

  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
}

function calculateLinearSlope(points) {
  const xMean = points.reduce((total, [x]) => total + x, 0) / points.length;
  const yMean = points.reduce((total, [, y]) => total + y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;

  for (const [x, y] of points) {
    numerator += (x - xMean) * (y - yMean);
    denominator += (x - xMean) ** 2;
  }

  return denominator === 0 ? 0 : numerator / denominator;
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(3)}s`;
}

function validateMetric(metric, artifactPath) {
  if (
    metric?.schemaVersion !== 1 ||
    metric.fixture !== "agent-workflow-stress" ||
    !REQUIRED_SCENARIOS.includes(metric.scenario) ||
    metric.unit !== "milliseconds"
  ) {
    throw new Error(`Invalid Workflow stress metric in ${artifactPath}`);
  }

  if (metric.scenario === "sequential") {
    validateSamples(metric.samples, artifactPath, "turnNumber");
    return;
  }

  if (!Array.isArray(metric.batches) || metric.batches.length === 0) {
    throw new Error(`Invalid concurrent Workflow stress batches in ${artifactPath}`);
  }

  for (const batch of metric.batches) {
    if (!Number.isInteger(batch?.turnNumber) || !isFiniteNonnegative(batch?.batchDurationMs)) {
      throw new Error(`Invalid concurrent Workflow stress batch in ${artifactPath}`);
    }

    validateSamples(batch.samples, artifactPath, "sessionNumber");
  }
}

function validateSamples(samples, artifactPath, ordinalKey) {
  if (
    !Array.isArray(samples) ||
    samples.length === 0 ||
    samples.some(
      (sample) =>
        !isFiniteNonnegative(sample?.durationMs) || !Number.isInteger(sample?.[ordinalKey]),
    )
  ) {
    throw new Error(`Invalid Workflow stress samples in ${artifactPath}`);
  }
}

function isFiniteNonnegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function findJsonFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name);

      if (entry.isDirectory()) {
        return findJsonFiles(path);
      }

      return entry.isFile() && entry.name.endsWith(".json") ? [path] : [];
    }),
  );

  return paths.flat();
}

function findEvalRunDirectory(artifactsRoot, artifactPath) {
  const root = resolve(artifactsRoot);
  const segments = relative(root, artifactPath).split(sep);
  const evalsIndex = segments.indexOf("evals");

  if (evalsIndex === -1) {
    throw new Error(`Workflow stress metric is outside an eval run directory: ${artifactPath}`);
  }

  return resolve(root, ...segments.slice(0, evalsIndex));
}

function parseArguments(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];

    if (!["--artifacts", "--json", "--markdown"].includes(name) || value === undefined) {
      throw new Error(
        "Usage: workflow-stress-report.mjs --artifacts <dir> [--json <path>] [--markdown <path>]",
      );
    }

    options[name.slice(2)] = value;
    index += 1;
  }

  if (options.artifacts === undefined) {
    throw new Error("--artifacts is required");
  }

  return options;
}

async function writeOutput(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const metrics = await collectWorkflowStressMetrics(options.artifacts);
  const report = createWorkflowStressReport(metrics, {
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    model: process.env.EVE_E2E_MODEL,
    runId: process.env.GITHUB_RUN_ID,
    sha: process.env.GITHUB_SHA,
  });
  const markdown = renderWorkflowStressMarkdown(report);

  if (options.json !== undefined) {
    await writeOutput(options.json, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (options.markdown !== undefined) {
    await writeOutput(options.markdown, markdown);
  }

  process.stdout.write(markdown);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
