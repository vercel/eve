import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDatasetTasks } from "./datasets.ts";
import { runDockerTrial } from "./docker.ts";
import { prepareEveCodeHarness } from "./harnesses/eve-code.ts";
import { preparePeerHarness } from "./harnesses/peers.ts";
import { buildReport, publishPrComment, writeReportFiles } from "./report.ts";
import {
  SUPPORTED_DATASETS,
  SUPPORTED_HARNESSES,
  type BenchmarkRunOptions,
  type DatasetName,
  type ExecutionMode,
  type HarnessBundle,
  type HarnessName,
  type PrebuiltBundleManifest,
  type ReasoningLevel,
  type TrialResult,
} from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = resolve(here, "../.cache/code-bench");

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function asString(args: Record<string, string | boolean>, key: string, fallback?: string): string {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument --${key}`);
}

function parseDataset(value: string): DatasetName {
  if ((SUPPORTED_DATASETS as readonly string[]).includes(value)) return value as DatasetName;
  throw new Error(
    `Unsupported --dataset "${value}". Expected one of: ${SUPPORTED_DATASETS.join(", ")}`,
  );
}

function parseHarnesses(value: string): HarnessName[] {
  const list = [...new Set(value.split(/[ ,]+/u).filter(Boolean))];
  if (list.length === 0) throw new Error("--harness must name at least one harness");
  for (const name of list) {
    if (!(SUPPORTED_HARNESSES as readonly string[]).includes(name)) {
      throw new Error(
        `Unsupported harness "${name}". Expected one of: ${SUPPORTED_HARNESSES.join(", ")}`,
      );
    }
  }
  return list as HarnessName[];
}

function parseReasoning(value: string): ReasoningLevel {
  if (value === "low" || value === "medium" || value === "high") return value;
  throw new Error(`Unsupported --reasoning "${value}". Expected low, medium, or high.`);
}

function parseExecution(value: string): ExecutionMode {
  if (value === "local" || value === "vercel-sandbox") return value;
  throw new Error(`Unsupported --execution "${value}". Expected local or vercel-sandbox.`);
}

function forwardCredentials(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

async function prepareHarness(
  harness: HarnessName,
  options: {
    readonly cacheDir: string;
    readonly model: string;
    readonly reasoning: ReasoningLevel;
  },
): Promise<HarnessBundle> {
  if (harness === "eve-code") {
    return await prepareEveCodeHarness(options);
  }
  return await preparePeerHarness({ harness, ...options });
}

function bundleFromManifest(
  cacheDir: string,
  entry: PrebuiltBundleManifest[HarnessName],
): HarnessBundle {
  if (!entry) throw new Error("Missing prebuilt bundle manifest entry");
  const dir = join(cacheDir, entry.bundleRelDir);
  const archDirs = entry.archRelDirs
    ? {
        x64: join(cacheDir, entry.archRelDirs.x64),
        arm64: join(cacheDir, entry.archRelDirs.arm64),
      }
    : undefined;
  if (entry.harness === "eve-code") {
    return {
      harness: "eve-code",
      version: entry.version,
      dir,
      archDirs,
      command: (ctx) => `exec '${ctx.installDir}/arch/node' '${ctx.installDir}/app/runner.mjs'`,
      env: (ctx) => ({
        EVE_PROJECT_DIR: `${ctx.installDir}/app`,
        EVE_INSTRUCTION_PATH: ctx.instructionPath,
        EVE_AGENT_LOGS_DIR: ctx.logsDir,
        CODE_BENCH_TASK_CONTAINER: "1",
        CODE_BENCH_TASK_WORKDIR: ctx.taskWorkdir,
        EVE_CODE_BENCH_MODEL: ctx.model,
        EVE_AGENT_TIMEOUT_MS: String(ctx.agentTimeoutMs),
      }),
    };
  }
  return {
    harness: entry.harness,
    version: entry.version,
    dir,
    archDirs,
    command: (ctx) => `exec '${ctx.installDir}/arch/node' '${ctx.installDir}/runner.mjs'`,
    env: (ctx) => ({
      CODE_BENCH_INSTALL_DIR: ctx.installDir,
      CODE_BENCH_INSTRUCTION_PATH: ctx.instructionPath,
      CODE_BENCH_LOGS_DIR: ctx.logsDir,
      CODE_BENCH_MODEL: ctx.model,
      CODE_BENCH_REASONING: ctx.reasoning,
      CODE_BENCH_TIMEOUT_MS: String(ctx.agentTimeoutMs),
    }),
  };
}

async function runWorkerMode(args: Record<string, string | boolean>): Promise<void> {
  const dataset = parseDataset(asString(args, "dataset"));
  const harness = parseHarnesses(asString(args, "harness"))[0]!;
  const taskName = asString(args, "task");
  const attempt = Number(asString(args, "attempt", "1"));
  const model = asString(args, "model");
  const reasoning = parseReasoning(asString(args, "reasoning", "high"));
  const cacheDir = resolve(asString(args, "cache-dir"));
  const outputDir = resolve(asString(args, "output"));

  const tasks = await loadDatasetTasks(dataset, cacheDir, taskName);
  const task = tasks[0]!;
  const manifest = JSON.parse(
    await readFile(join(cacheDir, "bundles.json"), "utf8"),
  ) as PrebuiltBundleManifest;
  const bundle = bundleFromManifest(cacheDir, manifest[harness]);

  await runDockerTrial({
    task,
    attempt,
    bundle,
    model,
    reasoning,
    trialDir: outputDir,
    forwardEnv: forwardCredentials(),
  });
}

async function runLocalTrials(input: {
  readonly options: BenchmarkRunOptions;
  readonly tasks: Awaited<ReturnType<typeof loadDatasetTasks>>;
  readonly bundles: ReadonlyMap<HarnessName, HarnessBundle>;
}): Promise<TrialResult[]> {
  const { options, tasks, bundles } = input;
  const forwardEnv = forwardCredentials();
  const queue: Array<{ harness: HarnessName; task: (typeof tasks)[number]; attempt: number }> = [];
  for (const harness of options.harnesses) {
    for (const task of tasks) {
      for (let attempt = 1; attempt <= options.attempts; attempt++) {
        queue.push({ harness, task, attempt });
      }
    }
  }

  const results: TrialResult[] = [];
  let nextIdx = 0;
  let done = 0;
  const total = queue.length;

  const worker = async () => {
    while (nextIdx < queue.length) {
      const job = queue[nextIdx++]!;
      const bundle = bundles.get(job.harness)!;
      const trialDir = join(
        options.outputDir,
        "trials",
        job.harness,
        job.task.name,
        String(job.attempt),
      );
      const result = await runDockerTrial({
        task: job.task,
        attempt: job.attempt,
        bundle,
        model: options.model,
        reasoning: options.reasoning,
        trialDir,
        forwardEnv,
      });
      results.push(result);
      done++;
      const mark =
        result.reward === 1
          ? "resolved"
          : result.reward === 0
            ? "reward 0"
            : `error (${result.error ?? "no reward"})`;
      console.log(
        `[${done}/${total}] ${job.harness}/${job.task.name}#${job.attempt}  ${mark}  ${Math.round(result.agent.durationMs / 1000)}s`,
      );
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, queue.length) }, () => worker()),
  );
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.worker === true) {
    await runWorkerMode(args);
    return;
  }

  if (args["publish-comment"] === true) {
    const prNumber = Number(asString(args, "pr"));
    await publishPrComment({
      commentPath: resolve(asString(args, "comment")),
      token: process.env.GITHUB_TOKEN ?? "",
      repository: asString(args, "repository", process.env.GITHUB_REPOSITORY),
      prNumber,
    });
    return;
  }

  const dataset = parseDataset(asString(args, "dataset", "deepswe-lean"));
  const harnesses = parseHarnesses(asString(args, "harness", "eve-code,opencode,pi,fx"));
  const model = asString(args, "model", "anthropic/claude-sonnet-5.5");
  const reasoning = parseReasoning(
    asString(args, "reasoning", dataset === "deepswe-lean" ? "high" : "low"),
  );
  const attempts = Number(asString(args, "attempts", dataset === "deepswe-lean" ? "3" : "5"));
  const concurrency = Number(asString(args, "concurrency", "4"));
  const execution = parseExecution(asString(args, "execution", "local"));
  const outputDir = resolve(asString(args, "output", "benchmark-results"));
  const cacheDir = resolve(asString(args, "cache-dir", DEFAULT_CACHE_DIR));
  const taskFilter = typeof args.task === "string" ? args.task : undefined;
  const sourceSha = typeof args.sha === "string" ? args.sha : (process.env.GITHUB_SHA ?? undefined);
  const runUrl =
    typeof args["run-url"] === "string"
      ? args["run-url"]
      : process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined;

  const options: BenchmarkRunOptions = {
    dataset,
    harnesses,
    model,
    reasoning,
    attempts,
    concurrency,
    execution,
    outputDir,
    taskFilter,
    sourceSha,
    runUrl,
  };

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });

  console.log(
    `[code-bench] dataset=${dataset} harnesses=${harnesses.join(",")} model=${model} reasoning=${reasoning} attempts=${attempts} execution=${execution}`,
  );
  const tasks = await loadDatasetTasks(dataset, cacheDir, taskFilter);
  const bundles = new Map<HarnessName, HarnessBundle>();
  const versions: Partial<Record<HarnessName, string>> = {};
  for (const harness of harnesses) {
    const bundle = await prepareHarness(harness, { cacheDir, model, reasoning });
    bundles.set(harness, bundle);
    versions[harness] = bundle.version;
  }

  const trials =
    execution === "vercel-sandbox"
      ? await (
          await import("./vercel-sandbox.ts")
        ).runOnVercelSandboxes({
          options,
          tasks,
          bundles,
          cacheDir,
        })
      : await runLocalTrials({ options, tasks, bundles });

  const report = buildReport({ options, tasks, trials, versions });
  await writeReportFiles(outputDir, report);
  console.log(`[code-bench] Done (${report.status}). Report written to ${outputDir}`);
  if (report.status === "incomplete") {
    const failed = trials.filter((t) => t.reward === null);
    console.error(`[code-bench] ${failed.length} trial(s) did not produce a reward.`);
    process.exitCode = 1;
  }
}

await main();
