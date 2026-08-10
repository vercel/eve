import { photonImessageCase } from "./cases/photon-imessage.js";
import { runBenchmark } from "./runner.js";
import { DEFAULT_SUMMARY_MODEL, summarizeRun } from "./summarize.js";

const cases = new Map([[photonImessageCase.id, photonImessageCase]]);
const args = process.argv.slice(2);
const caseId = positionalCaseId() ?? photonImessageCase.id;
const evaluation = cases.get(caseId);
if (evaluation === undefined) {
  process.stderr.write(
    `Unknown benchmark ${JSON.stringify(caseId)}. Available: ${[...cases.keys()].join(", ")}\n`,
  );
  process.exit(2);
}

const model = option("--model");
const timeout = option("--timeout");
let artifact = await runBenchmark({
  evaluation,
  ...(model === undefined ? {} : { model }),
  ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
  onProgress(message) {
    process.stderr.write(`[benchmark] ${message}\n`);
  },
  onDiagnostic(event) {
    if (!args.includes("--verbose")) return;
    process.stderr.write(`[harness] ${formatDiagnostic(event)}\n`);
  },
});

const summaryOption = flagValue("--summarize");
if (summaryOption !== undefined) {
  const summaryModel =
    summaryOption === true ? (option("--summary-model") ?? DEFAULT_SUMMARY_MODEL) : summaryOption;
  process.stderr.write(`[benchmark] Summarizing run with ${summaryModel}\n`);
  try {
    artifact = { ...artifact, summary: await summarizeRun(artifact, summaryModel) };
    await writeArtifactSummary(artifact);
  } catch (error) {
    process.stderr.write(
      `[benchmark] Could not summarize run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

for (const check of artifact.grade.checks) {
  process.stdout.write(`${check.passed ? "✓" : "✗"} ${check.id}: ${check.detail}\n`);
}
if (artifact.error !== undefined) process.stderr.write(`${artifact.error}\n`);
if (artifact.summary !== undefined) {
  process.stdout.write(`\nSummary (${artifact.summary.model}):\n${artifact.summary.text}\n`);
}
process.stdout.write(`\nArtifact: ${artifact.artifactPath}\n`);
process.stdout.write(`${artifact.grade.passed ? "PASS" : "FAIL"} ${artifact.caseId}\n`);
process.exitCode = artifact.grade.passed && artifact.error === undefined ? 0 : 1;

async function writeArtifactSummary(value: typeof artifact): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(value.artifactPath, `${JSON.stringify(value, null, 2)}\n`);
}

function flagValue(name: string): true | string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const next = args[index + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}

function formatDiagnostic(value: unknown): string {
  if (typeof value !== "object" || value === null) return String(value);
  if ("message" in value && typeof value.message === "string") {
    const subsystem =
      "subsystem" in value && typeof value.subsystem === "string" ? `${value.subsystem}: ` : "";
    return `${subsystem}${value.message}`;
  }
  return JSON.stringify(value);
}

function positionalCaseId(): string | undefined {
  const valueOptions = new Set(["--model", "--timeout", "--summary-model"]);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (valueOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (argument === "--summarize") {
      if (args[index + 1]?.includes("/") === true) index += 1;
      continue;
    }
    if (!argument.startsWith("--")) return argument;
  }
  return undefined;
}

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
