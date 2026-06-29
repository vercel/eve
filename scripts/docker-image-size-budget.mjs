import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function formatBytes(bytes) {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }

  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(1)} kB`;
  }

  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function formatRatioPercent(ratio) {
  if (!Number.isFinite(ratio)) {
    return "new";
  }

  return `${(ratio * 100).toFixed(1)}%`;
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node ./scripts/docker-image-size-budget.mjs --report-json <path>",
      "",
      "Options:",
      "  --report-json <path>  Docker image size report JSON",
      "  --help                Show this help text",
      "",
    ].join("\n"),
  );
}

function parseArguments(argv) {
  const parsedArguments = {
    reportJsonPath: null,
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

    if (argument === "--report-json") {
      parsedArguments.reportJsonPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument "${argument}".`);
  }

  if (parsedArguments.reportJsonPath === null) {
    throw new Error('The "--report-json" option is required.');
  }

  return parsedArguments;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const report = JSON.parse(await readFile(resolve(args.reportJsonPath), "utf8"));
  const comparison = report.comparison;
  const sizeBudget = comparison?.sizeBudget;

  if (!comparison || !sizeBudget) {
    process.stderr.write("Docker image size report does not contain a baseline comparison.\n");
    process.exitCode = 1;
    return;
  }

  if (!sizeBudget.failed) {
    process.stdout.write("Docker image size budget passed.\n");
    return;
  }

  process.stderr.write(
    [
      "Docker image size budget exceeded:",
      `- Image size grew ${formatRatioPercent(sizeBudget.increaseRatio)} (${formatBytes(comparison.sizeBytes.baseline)} -> ${formatBytes(comparison.sizeBytes.current)}), above the ${formatRatioPercent(sizeBudget.thresholdRatio)} limit.`,
      "",
      "The pull request comment contains the same failure details.",
      "",
    ].join("\n"),
  );
  process.exitCode = 1;
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
