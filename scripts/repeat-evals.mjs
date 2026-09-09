import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repetitions = Number(process.env.EVE_E2E_REPETITIONS);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 500) {
  throw new Error("EVE_E2E_REPETITIONS must be an integer from 1 to 500.");
}
const evalIds = (process.env.EVE_E2E_EVAL_IDS ?? "").split(/\s+/).filter(Boolean);
if (
  evalIds.length > 64 ||
  evalIds.some((id) => id.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(id))
) {
  throw new Error("Pass up to 64 plain eval IDs or directory prefixes, not CLI options.");
}
if (!process.env.EVE_EVAL_JUNIT_DIR) {
  throw new Error("EVE_EVAL_JUNIT_DIR is required for repetition evidence.");
}

const directory = resolve(process.env.EVE_EVAL_JUNIT_DIR, "repetitions");
await mkdir(directory, { recursive: true });
const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../packages/eve/bin/eve.js", import.meta.url));
const trials = [];
const startedAt = new Date().toISOString();

for (let index = 0; index < repetitions; index += 1) {
  const prefix = resolve(directory, String(index + 1).padStart(4, "0"));
  let stdout = "";
  let stderr = "";
  let error;
  try {
    ({ stdout, stderr } = await exec(
      process.execPath,
      [cli, "eval", ...evalIds, "--strict", "--json", "--skip-report", "--junit", `${prefix}.xml`],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 },
    ));
  } catch (failure) {
    stdout = failure.stdout ?? "";
    stderr = failure.stderr ?? "";
    error = failure.message;
  }
  await writeFile(`${prefix}.stdout.log`, stdout);
  await writeFile(`${prefix}.stderr.log`, stderr);
  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch {
    error ??= "The eval process did not produce valid JSON.";
  }
  const passed =
    error === undefined &&
    summary?.failed === 0 &&
    summary?.errored === 0 &&
    summary?.skipped === 0 &&
    summary?.totalEvals > 0 &&
    summary.passed + summary.scored === summary.totalEvals;
  trials.push({ repetition: index + 1, passed, error, summary });
  await writeFile(resolve(directory, "trials.json"), JSON.stringify(trials, null, 2) + "\n");
  console.log(
    `${index + 1}/${repetitions} repetitions; ${trials.filter((trial) => !trial.passed).length} failures`,
  );
}

const failures = trials.filter((trial) => !trial.passed).length;
const report = {
  commit: process.env.GITHUB_SHA,
  model: process.env.EVE_E2E_MODEL,
  evalIds,
  startedAt,
  completedAt: new Date().toISOString(),
  repetitions,
  failures,
  confidence: 0.95,
  oneSidedFailureRateUpperBound: failures === 0 ? -Math.expm1(Math.log(0.05) / repetitions) : null,
  scope:
    "Selected evals in fresh CLI processes, with every failure retained; assumes independent, stationary trials.",
};
await writeFile(resolve(directory, "summary.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
process.exitCode = failures === 0 ? 0 : 1;
