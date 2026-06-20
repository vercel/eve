import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE_BUDGET_THRESHOLD = 0.1;

function formatBytes(bytes) {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }

  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(1)} kB`;
  }

  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatSignedBytes(bytes) {
  if (bytes === 0) {
    return "0 B";
  }

  return `${bytes > 0 ? "+" : "-"}${formatBytes(Math.abs(bytes))}`;
}

function formatRatioPercent(ratio) {
  if (!Number.isFinite(ratio)) {
    return "new";
  }

  return `${(ratio * 100).toFixed(1)}%`;
}

function parseSizeBytes(value, label) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer byte count.`);
  }

  return parsed;
}

function calculateIncreaseRatio(baselineBytes, currentBytes) {
  const deltaBytes = currentBytes - baselineBytes;

  if (deltaBytes <= 0) {
    return 0;
  }

  if (baselineBytes <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return deltaBytes / baselineBytes;
}

function createComparison(input) {
  const deltaBytes = input.currentSizeBytes - input.baselineSizeBytes;
  const increaseRatio = calculateIncreaseRatio(input.baselineSizeBytes, input.currentSizeBytes);

  return {
    baselineLabel: input.baselineLabel,
    sizeBudget: {
      failed: increaseRatio >= SIZE_BUDGET_THRESHOLD,
      increaseRatio,
      thresholdRatio: SIZE_BUDGET_THRESHOLD,
    },
    sizeBytes: {
      baseline: input.baselineSizeBytes,
      current: input.currentSizeBytes,
      delta: deltaBytes,
    },
  };
}

function summarizeComparison(comparison) {
  const sizeMetric = comparison.sizeBytes;

  if (sizeMetric.delta === 0) {
    return [`- Image size is unchanged vs \`${comparison.baselineLabel}\`.`];
  }

  const direction = sizeMetric.delta > 0 ? "increased" : "decreased";
  const ratioText =
    sizeMetric.delta > 0 ? ` (${formatRatioPercent(comparison.sizeBudget.increaseRatio)})` : "";

  return [
    `- Image size ${direction} ${formatSignedBytes(sizeMetric.delta)}${ratioText}: ${formatBytes(sizeMetric.baseline)} -> ${formatBytes(sizeMetric.current)}.`,
    `- Size budget fails at ${formatRatioPercent(comparison.sizeBudget.thresholdRatio)} or more growth.`,
  ];
}

function renderBudgetSection(report) {
  const sizeBudget = report.comparison.sizeBudget;

  if (!sizeBudget.failed) {
    return [];
  }

  const sizeMetric = report.comparison.sizeBytes;

  return [
    "### Docker Image Size Budget: Action Will Fail",
    "",
    "This action will fail because the Docker image grew by 10.0% or more.",
    "",
    "| Metric | Details |",
    "| --- | --- |",
    `| Image size | ${formatBytes(sizeMetric.baseline)} -> ${formatBytes(sizeMetric.current)}; ${formatSignedBytes(sizeMetric.delta)} (${formatRatioPercent(sizeBudget.increaseRatio)}) over limit ${formatRatioPercent(sizeBudget.thresholdRatio)} |`,
    "",
  ];
}

export function renderDockerImageSizeReportMarkdown(report) {
  const comparison = report.comparison;
  const lines = [
    `## Docker Image Size Summary: \`${report.imageLabel}\``,
    "",
    "**Key takeaways**",
    "",
    ...summarizeComparison(comparison),
    "",
    ...renderBudgetSection(report),
    `### Delta vs \`${comparison.baselineLabel}\``,
    "",
    "| Metric | Baseline | Current | Delta |",
    "| --- | --- | --- | --- |",
    `| Image size | ${formatBytes(comparison.sizeBytes.baseline)} | ${formatBytes(comparison.sizeBytes.current)} | ${formatSignedBytes(comparison.sizeBytes.delta)} |`,
    "",
    "### Metadata",
    "",
    `- Current: \`${report.currentLabel}\``,
    `- Generated at: \`${report.generatedAt}\``,
  ];

  return lines.join("\n");
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node ./scripts/docker-image-size-report.mjs --baseline-size-bytes <bytes> --current-size-bytes <bytes> [options]",
      "",
      "Options:",
      "  --baseline-size-bytes <bytes>  Docker image size for the baseline image",
      "  --current-size-bytes <bytes>   Docker image size for the current image",
      "  --baseline-label <label>       Display label used for the baseline comparison",
      "  --current-label <label>        Display label used for the current image",
      "  --image-label <label>          Display label for the analyzed image",
      "  --output-json <path>           Write the JSON report to this file",
      "  --output-markdown <path>       Write the Markdown report to this file",
      "  --help                         Show this help text",
      "",
    ].join("\n"),
  );
}

function parseArguments(argv) {
  const parsedArguments = {
    baselineLabel: "baseline",
    baselineSizeBytes: null,
    currentLabel: "current",
    currentSizeBytes: null,
    imageLabel: "Dockerfile",
    outputJsonPath: null,
    outputMarkdownPath: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help") {
      printUsage();
      process.exit(0);
    }

    const value = argv[index + 1];

    if (value === undefined) {
      throw new Error(`Missing value for "${argument}".`);
    }

    if (argument === "--baseline-size-bytes") {
      parsedArguments.baselineSizeBytes = parseSizeBytes(value, "--baseline-size-bytes");
      index += 1;
      continue;
    }

    if (argument === "--current-size-bytes") {
      parsedArguments.currentSizeBytes = parseSizeBytes(value, "--current-size-bytes");
      index += 1;
      continue;
    }

    if (argument === "--baseline-label") {
      parsedArguments.baselineLabel = value;
      index += 1;
      continue;
    }

    if (argument === "--current-label") {
      parsedArguments.currentLabel = value;
      index += 1;
      continue;
    }

    if (argument === "--image-label") {
      parsedArguments.imageLabel = value;
      index += 1;
      continue;
    }

    if (argument === "--output-json") {
      parsedArguments.outputJsonPath = value;
      index += 1;
      continue;
    }

    if (argument === "--output-markdown") {
      parsedArguments.outputMarkdownPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument "${argument}".`);
  }

  if (parsedArguments.baselineSizeBytes === null) {
    throw new Error('The "--baseline-size-bytes" option is required.');
  }

  if (parsedArguments.currentSizeBytes === null) {
    throw new Error('The "--current-size-bytes" option is required.');
  }

  return parsedArguments;
}

async function writeOutputFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const report = {
    comparison: createComparison(args),
    currentLabel: args.currentLabel,
    generatedAt: new Date().toISOString(),
    imageLabel: args.imageLabel,
  };
  const markdown = renderDockerImageSizeReportMarkdown(report);

  if (args.outputJsonPath) {
    await writeOutputFile(args.outputJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (args.outputMarkdownPath) {
    await writeOutputFile(args.outputMarkdownPath, `${markdown}\n`);
  }

  if (!args.outputMarkdownPath) {
    process.stdout.write(`${markdown}\n`);
  }
}

const executedScriptPath = process.argv[1] ? resolve(process.argv[1]) : null;
const moduleScriptPath = resolve(fileURLToPath(import.meta.url));

if (
  executedScriptPath !== null &&
  moduleScriptPath !== null &&
  executedScriptPath === moduleScriptPath
) {
  await main();
}
