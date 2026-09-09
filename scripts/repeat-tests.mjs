import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { zeroFailureUpperBound } from "./flake-validation-results.mjs";

const exec = promisify(execFile);
const [runsText, output, ...args] = process.argv.slice(2);
const runs = Number(runsText);
if (!Number.isInteger(runs) || runs < 1 || runs > 1_000 || !output || args.length === 0) {
  throw new Error(
    "Usage: node scripts/repeat-tests.mjs <runs:1-1000> <output-directory> --config vitest.<tier>.config.ts <tests...>",
  );
}
const config = args[args.indexOf("--config") + 1];
if (
  !args.includes("--config") ||
  !/^vitest\.(unit|integration|scenario)\.config\.ts$/.test(config)
) {
  throw new Error("Pass an explicit unit, integration, or scenario tier config.");
}
const packageRoot = fileURLToPath(new URL("../packages/eve/", import.meta.url));
const vitest = resolve(packageRoot, "node_modules/vitest/vitest.mjs");
const directory = resolve(output);
const workerArgs = args.some((arg) => arg === "--maxWorkers" || arg.startsWith("--maxWorkers="))
  ? []
  : ["--maxWorkers=1"];
await mkdir(directory, { recursive: true });
const trials = [];
const startedAt = new Date().toISOString();

for (let trial = 0; trial < runs; trial += 1) {
  const prefix = resolve(directory, String(trial + 1).padStart(4, "0"));
  const reportPath = `${prefix}.json`;
  const seed = 20_260_909 + trial;
  let passed = false;
  let testCount = 0;
  let detail;
  try {
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        vitest,
        "run",
        ...args,
        "--retry=0",
        ...workerArgs,
        "--sequence.shuffle",
        `--sequence.seed=${seed}`,
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      { cwd: packageRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000 },
    );
    await writeFile(`${prefix}.log`, stdout + stderr);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    testCount = report.numPassedTests;
    passed = report.success === true && testCount > 0 && report.numFailedTests === 0;
    if (!passed) detail = "The test report did not contain a successful, nonempty run.";
  } catch (error) {
    detail = error.message;
    await writeFile(`${prefix}.log`, (error.stdout ?? "") + (error.stderr ?? "") + detail);
  }
  trials.push({ trial: trial + 1, seed, passed, testCount, detail });
  await writeFile(resolve(directory, "trials.json"), JSON.stringify(trials, null, 2) + "\n");
  if ((trial + 1) % 10 === 0 || trial === runs - 1) {
    console.log(
      `${trial + 1}/${runs} runs; ${trials.filter((result) => !result.passed).length} failures`,
    );
  }
}

const failures = trials.filter((trial) => !trial.passed).length;
const summary = {
  command: [process.execPath, vitest, "run", ...args],
  startedAt,
  completedAt: new Date().toISOString(),
  platform: process.platform,
  nodeVersion: process.version,
  runs,
  failures,
  passedTests: trials.reduce((total, trial) => total + trial.testCount, 0),
  confidence: 0.95,
  oneSidedFailureRateUpperBound: failures === 0 ? zeroFailureUpperBound(runs) : null,
  scope:
    "Repeatability of the selected tests under independent, stationary trials; not the failure rate of all CI jobs.",
};
await writeFile(resolve(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
process.exitCode = failures === 0 ? 0 : 1;
