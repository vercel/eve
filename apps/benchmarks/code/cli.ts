import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDatasetTasks } from "./datasets.ts";
import { runDockerTrial } from "./docker.ts";
import { prepareEveCodeHarness } from "./harnesses/eve-code.ts";
import { ensureNodeRuntime } from "./harnesses/node-runtime.ts";
import { preparePeerHarness } from "./harnesses/peers.ts";
import { forwardCredentials, runTrialPool } from "./pool.ts";
import { buildReport, writeReportFiles } from "./report.ts";
import {
  SUPPORTED_DATASETS,
  SUPPORTED_HARNESSES,
  type BenchmarkRunOptions,
  type DatasetName,
  type ExecutionMode,
  type HarnessBundle,
  type HarnessName,
  type LinuxArch,
  type PrebuiltBundleManifest,
} from "./types.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = resolve(THIS_DIR, "../.cache/code-bench");

interface ParsedArgs {
  readonly flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags };
}

function strFlag(flags: ParsedArgs["flags"], key: string, fallback?: string): string | undefined {
  const val = flags[key];
  return typeof val === "string" && val.length > 0 ? val : fallback;
}

function numFlag(flags: ParsedArgs["flags"], key: string, fallback: number): number {
  const raw = strFlag(flags, key);
  if (!raw) return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid numeric value for --${key}: ${raw}`);
  }
  return Math.floor(num);
}

function parseDataset(raw: string | undefined): DatasetName {
  const value = raw ?? "swe-lean";
  if ((SUPPORTED_DATASETS as readonly string[]).includes(value)) return value as DatasetName;
  throw new Error(`Unsupported --dataset "${value}". Supported: ${SUPPORTED_DATASETS.join(", ")}`);
}

function parseHarnesses(raw: string | undefined): HarnessName[] {
  const list = (raw ?? "eve-code")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error("At least one harness is required.");
  const seen = new Set<HarnessName>();
  for (const item of list) {
    if (!(SUPPORTED_HARNESSES as readonly string[]).includes(item)) {
      throw new Error(
        `Unsupported harness "${item}". Supported: ${SUPPORTED_HARNESSES.join(", ")}`,
      );
    }
    seen.add(item as HarnessName);
  }
  return [...seen];
}

function resolveRelDirs(
  cacheDir: string,
  relDirs: Partial<Record<LinuxArch, string>> | undefined,
): Record<LinuxArch, string> | undefined {
  if (!relDirs) return undefined;
  const out = {} as Record<LinuxArch, string>;
  if (relDirs.x64) out.x64 = join(cacheDir, relDirs.x64);
  if (relDirs.arm64) out.arm64 = join(cacheDir, relDirs.arm64);
  return out;
}

async function runWorkerMode(flags: ParsedArgs["flags"]): Promise<void> {
  const dataset = parseDataset(strFlag(flags, "dataset"));
  const harnesses = parseHarnesses(strFlag(flags, "harness"));
  const harness = harnesses[0]!;
  const taskFilter = strFlag(flags, "task");
  const attempt = numFlag(flags, "attempt", 1);
  const model = strFlag(flags, "model") ?? "anthropic/claude-sonnet-5.5";
  const reasoning = strFlag(flags, "reasoning") ?? "high";
  const cacheDir = resolve(strFlag(flags, "cache") ?? DEFAULT_CACHE_DIR);
  const outputDir = resolve(strFlag(flags, "output") ?? "/tmp/trial-out");

  const manifest = JSON.parse(
    await readFile(join(cacheDir, "bundles.json"), "utf8"),
  ) as PrebuiltBundleManifest;
  const entry = manifest.bundles[harness];
  if (!entry) throw new Error(`Bundle manifest missing harness ${harness}`);

  const nodeDirs = resolveRelDirs(cacheDir, manifest.nodeRelDirs);
  if (!nodeDirs) throw new Error("Bundle manifest missing nodeRelDirs");

  const bundle: HarnessBundle = {
    harness: entry.harness,
    version: entry.version,
    dir: entry.bundleRelDir ? join(cacheDir, entry.bundleRelDir) : undefined,
    archDirs: resolveRelDirs(cacheDir, entry.archRelDirs),
  };

  const tasks = await loadDatasetTasks(dataset, cacheDir, taskFilter);
  const task = tasks[0];
  if (!task) throw new Error(`Task not found: ${taskFilter}`);

  await runDockerTrial({
    task,
    attempt,
    bundle,
    nodeDirs,
    model,
    reasoning,
    trialDir: outputDir,
    forwardEnv: forwardCredentials(),
  });
}

async function clearPreviousOutputs(outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  for (const name of ["trials", "report.json", "report.md", "comment.md"]) {
    await rm(join(outputDir, name), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    console.log(
      [
        "Usage: pnpm --filter @eve-internal/benchmarks code-bench [options]",
        "",
        "  --dataset <swe-lean|deepswe-lean>         Dataset to run (default: swe-lean)",
        "  --harness <eve-code,opencode,pi,fx>       Comma-separated harnesses (default: eve-code)",
        "  --model <provider/model>                  Model ID (default: anthropic/claude-sonnet-5.5)",
        "  --reasoning <none|low|medium|high|xhigh>  Reasoning effort (default: high)",
        "  --attempts <n>                            Attempts per task (default: 3)",
        "  --concurrency <n>                         Parallel trials (default: 4)",
        "  --execution <local|vercel-sandbox>        Execution backend (default: local)",
        "  --task <name[,name]>                      Filter to specific task(s)",
        "  --output <dir>                            Output directory (default: benchmark-results)",
        "  --cache <dir>                             Cache directory",
        "  --source-sha <sha>                        Source commit SHA for report metadata",
        "  --run-url <url>                           CI run URL for report metadata",
      ].join("\n"),
    );
    return;
  }

  if (flags.worker) {
    await runWorkerMode(flags);
    return;
  }

  const dataset = parseDataset(strFlag(flags, "dataset"));
  const harnesses = parseHarnesses(strFlag(flags, "harness"));
  const model = strFlag(flags, "model") ?? "anthropic/claude-sonnet-5.5";
  const reasoning = strFlag(flags, "reasoning") ?? (dataset === "swe-lean" ? "low" : "high");
  const attempts = numFlag(flags, "attempts", dataset === "swe-lean" ? 5 : 3);
  const concurrency = numFlag(flags, "concurrency", 4);
  const execution = (strFlag(flags, "execution") ?? "local") as ExecutionMode;
  if (execution !== "local" && execution !== "vercel-sandbox") {
    throw new Error(`Unsupported --execution "${execution}". Use "local" or "vercel-sandbox".`);
  }
  const outputDir = resolve(strFlag(flags, "output") ?? "benchmark-results");
  const cacheDir = resolve(strFlag(flags, "cache") ?? DEFAULT_CACHE_DIR);
  const taskFilter = strFlag(flags, "task");
  const sourceSha = strFlag(flags, "sha") ?? strFlag(flags, "source-sha") ?? process.env.GITHUB_SHA;
  const runUrl =
    strFlag(flags, "run-url") ??
    (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined);

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

  console.log(
    `Loading ${dataset} tasks and preparing ${harnesses.join(", ")} for ${model} (reasoning=${reasoning})...`,
  );
  const [tasks, nodeDirs] = await Promise.all([
    loadDatasetTasks(dataset, cacheDir, taskFilter),
    ensureNodeRuntime(cacheDir),
  ]);

  const bundles = new Map<HarnessName, HarnessBundle>();
  for (const harness of harnesses) {
    if (harness === "eve-code") {
      bundles.set(harness, await prepareEveCodeHarness({ cacheDir, model, reasoning }));
    } else {
      bundles.set(harness, await preparePeerHarness({ harness, cacheDir }));
    }
  }

  const versions: Partial<Record<HarnessName, string>> = {};
  for (const [harness, bundle] of bundles) {
    versions[harness] = bundle.version;
  }

  await clearPreviousOutputs(outputDir);

  let writeChain = Promise.resolve();
  const persistProgress = (completed: readonly import("./types.ts").TrialResult[]) => {
    const snapshot = [...completed];
    writeChain = writeChain
      .then(() =>
        writeReportFiles(outputDir, buildReport({ options, tasks, trials: snapshot, versions })),
      )
      .catch(() => {});
    return writeChain;
  };

  let trials;
  if (execution === "vercel-sandbox") {
    const { runOnVercelSandboxes } = await import("./vercel-sandbox.ts");
    trials = await runOnVercelSandboxes({
      runOptions: options,
      tasks,
      cacheDir,
      nodeDirs,
      bundles,
      onTrialComplete: persistProgress,
    });
  } else {
    const forwardEnv = forwardCredentials();
    trials = await runTrialPool({
      runOptions: options,
      tasks,
      onTrialComplete: persistProgress,
      execute: (job) =>
        runDockerTrial({
          task: job.task,
          attempt: job.attempt,
          bundle: bundles.get(job.harness)!,
          nodeDirs,
          model: options.model,
          reasoning: options.reasoning,
          trialDir: job.trialDir,
          forwardEnv,
        }),
    });
  }

  await writeChain;
  const report = buildReport({ options, tasks, trials, versions });
  await writeReportFiles(outputDir, report);
  console.log(`Report written to ${join(outputDir, "report.md")}`);
  if (trials.length > 0 && trials.every((t) => t.reward === null)) {
    throw new Error("All benchmark trials failed without producing a verifier reward.");
  }
}

await main();
