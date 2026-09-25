#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { syncDataset, taskDirs } from "./core/dataset.ts";
import { readJobResult, runJob } from "./core/job.ts";
import { diffJobs, formatDiff, formatReport, type ReportFormat } from "./core/report.ts";
import { loadTask } from "./core/task.ts";
import {
  allLocks,
  defaultJobName,
  forwardedEnv,
  jobDir,
  lock,
  paths,
  selectHarness,
  selectTasks,
} from "./options.ts";

const USAGE = `eve-bench: zero-dependency Terminal-Bench runner for eve

  eve-bench tasks sync [--dataset <name>]        fetch pinned datasets into .generated/datasets
  eve-bench tasks list [--cohort <name>]         print task names
  eve-bench run --model <id> [--cohort <name>] [--task <name>...] [--task-dir <path>...] [--attempts N]
                [--concurrency N] [--harness eve|e0|oracle|pi|opencode|codex] [--job <name>]
                [--eve local|<version>] [--agent <e0-app>] [--version <cli-version>]
                [--reasoning <level>] [--base-url <https-url>] [--format console|json|junit]
  eve-bench prepare --harness <name> --model <id> [harness options]  build/cache without model calls
  eve-bench report <job> [--format console|json|junit] [--fail-on-invalid]
  eve-bench diff <base-job> <candidate-job> [--json]

Jobs live in .generated/jobs/<job>; re-running with the same --job resumes it.
Provider credentials are read from the environment and forwarded into the task container.
`;

const [command, subcommand, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "tasks":
      await tasks(subcommand, rest);
      break;
    case "prepare":
    case "run":
      await run(subcommand === undefined ? [] : [subcommand, ...rest], command === "prepare");
      break;
    case "report":
      await report(subcommand, rest);
      break;
    case "diff":
      await diff(subcommand, rest);
      break;
    default:
      process.stdout.write(USAGE);
      process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  }
} catch (error) {
  process.stderr.write(`eve-bench: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function tasks(sub: string | undefined, args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { dataset: { type: "string" }, cohort: { type: "string" }, json: { type: "boolean" } },
  });
  if (sub === "sync") {
    const locks = values.dataset ? [await lock(values.dataset)] : await allLocks();
    for (const entry of locks) {
      const dir = await syncDataset(join(paths.generatedRoot, "datasets"), entry);
      process.stdout.write(
        values.json
          ? `${JSON.stringify({ dataset: entry.name, version: entry.version, dir })}\n`
          : `${entry.name}@${entry.version} -> ${dir}\n`,
      );
    }
    return;
  }
  if (sub === "list") {
    const selection = await selectTasks(values);
    process.stdout.write(
      values.json ? `${JSON.stringify(selection.tasks)}\n` : `${selection.tasks.join("\n")}\n`,
    );
    return;
  }
  throw new Error(`unknown tasks subcommand: ${sub ?? "(none)"}\n${USAGE}`);
}

async function run(args: string[], prepareOnly = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      model: { type: "string" },
      cohort: { type: "string" },
      dataset: { type: "string" },
      task: { type: "string", multiple: true },
      "task-dir": { type: "string", multiple: true },
      attempts: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
      eve: { type: "string", default: "local" },
      harness: { type: "string", default: "eve" },
      agent: { type: "string" },
      version: { type: "string" },
      "base-url": { type: "string" },
      reasoning: { type: "string" },
      job: { type: "string" },
      format: { type: "string", default: "console" },
      json: { type: "boolean" },
    },
  });
  const harness = selectHarness(values.harness, values.eve, {
    ...values,
    baseUrl: values["base-url"],
  });
  const model = values.model ?? (harness.name === "oracle" ? "none" : undefined);
  if (!model) throw new Error("--model is required");
  if (prepareOnly) {
    const bundle = await harness.prepare({ model, cacheDir: join(paths.generatedRoot, "cache") });
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    return;
  }
  const forwardEnv = forwardedEnv(harness);
  const selection = await selectTasks({ ...values, taskDir: values["task-dir"] });
  const datasetTaskDirs = selection.tasks.length
    ? await taskDirs(
        await syncDataset(join(paths.generatedRoot, "datasets"), selection.lock),
        selection.tasks,
      )
    : [];
  const loaded = await Promise.all(
    [...datasetTaskDirs, ...selection.taskDirs].map((dir) => loadTask(dir)),
  );
  const name = values.job ?? defaultJobName(`${harness.name}-${model}`);
  const controller = new AbortController();
  const stop = () => {
    process.stderr.write("\neve-bench: aborting, cleaning up containers...\n");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const format = reportFormat(values.json ? "json" : values.format);
  const result = await runJob({
    name,
    dir: join(paths.generatedRoot, "jobs", name),
    cacheDir: join(paths.generatedRoot, "cache"),
    dataset: selection.lock,
    tasks: loaded,
    harness,
    model,
    attempts: Number(values.attempts),
    concurrency: Number(values.concurrency),
    forwardEnv,
    signal: controller.signal,
    onLog: (message) => process.stderr.write(`${message}\n`),
    onTrial: (trial, resumed) => {
      if (format !== "console") return;
      const reward = trial.reward === null ? "-" : trial.reward.toFixed(2);
      process.stderr.write(
        `${resumed ? "resume" : "trial "} ${trial.task}#${trial.attempt} reward=${reward} agent=${trial.agent.status} verifier=${trial.verifier.status}${trial.invalid ? ` INVALID(${trial.invalid.phase}): ${trial.invalid.reason}` : ""}\n`,
      );
    },
  });
  process.stdout.write(formatReport(result, format));
  if (controller.signal.aborted) process.exitCode = 130;
}

async function report(job: string | undefined, args: string[]): Promise<void> {
  if (!job) throw new Error("report requires a job name");
  const { values } = parseArgs({
    args,
    options: {
      format: { type: "string", default: "console" },
      json: { type: "boolean" },
      out: { type: "string" },
      "fail-on-invalid": { type: "boolean" },
    },
  });
  const result = await readJobResult(join(paths.generatedRoot, "jobs", job));
  const output = formatReport(result, reportFormat(values.json ? "json" : values.format));
  if (values.out) await writeFile(values.out, output);
  else process.stdout.write(output);
  const invalid = Object.values(result.summary.invalid).reduce((sum, count) => sum + count, 0);
  if (values["fail-on-invalid"] && invalid > 0) {
    process.stderr.write(
      `${invalid} of ${result.summary.attempts} attempt(s) are invalid and did not measure the harness.\n`,
    );
    process.exitCode = 1;
  }
}

async function diff(base: string | undefined, args: string[]): Promise<void> {
  const [candidate, ...restArgs] = args;
  if (!base || !candidate) throw new Error("diff requires <base-job> <candidate-job>");
  const { values } = parseArgs({ args: restArgs, options: { json: { type: "boolean" } } });
  const deltas = diffJobs(
    await readJobResult(jobDir(base)),
    await readJobResult(jobDir(candidate)),
  );
  process.stdout.write(values.json ? `${JSON.stringify(deltas, null, 2)}\n` : formatDiff(deltas));
}

function reportFormat(value: string | undefined): ReportFormat {
  if (value === "console" || value === "json" || value === "junit") return value;
  throw new Error(`unknown format: ${value}`);
}
