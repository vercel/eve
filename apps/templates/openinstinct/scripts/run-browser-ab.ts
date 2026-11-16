import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import nextEnvironment from "@next/env";
import { z } from "zod";
import {
  type BrowserBenchmarkLiveStatus,
  readBrowserBenchmarkLiveStatus,
  updateBrowserBenchmarkLiveStatus,
  writeBrowserBenchmarkLiveStatus,
} from "../evals/browser/live-status.ts";

const { loadEnvConfig } = nextEnvironment;
const nodeErrorSchema = z.object({ code: z.string() });
const errorMessageSchema = z.preprocess(
  (value) => (value instanceof Error ? value.message : String(value)),
  z.string()
);

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
// oxlint-disable-next-line eslint/no-restricted-properties -- the benchmark supervisor must forward credentials and provider configuration to isolated child revisions
let inheritedEnvironment = { ...process.env };
const options = parseArguments(process.argv.slice(2));
const timestamp = new Date().toISOString().replaceAll(":", "-");
const outputDirectory = join(repositoryRoot, ".eve", "browser-ab", timestamp);
const liveStatusPath = join(repositoryRoot, ".eve", "browser-ab", "live.json");
const temporaryRoot = await mkdtemp(join(tmpdir(), "eve-browser-ab-"));
const processes: ChildProcess[] = [];
const composeProjects: { cwd: string; name: string }[] = [];
const localDatabases: { maintenanceUrl: string; name: string }[] = [];
let keepResources = options.keep;
let liveStatusInitialized = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    keepResources = false;
    void cleanup().finally(() => process.exit(130));
  });
}

try {
  inheritedEnvironment = await refreshGatewayEnvironment();
  await mkdir(outputDirectory, { recursive: true });
  const [baselineSha, candidateSha] = await Promise.all([
    resolveCommit(options.baselineRef),
    resolveCommit(options.candidateRef),
  ]);
  const variants = [
    variant("baseline", baselineSha),
    variant("candidate", candidateSha),
  ] as const;
  await archivePreviousLiveStatus();
  await writeBrowserBenchmarkLiveStatus(
    liveStatusPath,
    initialLiveStatus(variants)
  );
  liveStatusInitialized = true;

  console.log(
    `Preparing browser A/B: ${shortSha(baselineSha)} → ${shortSha(candidateSha)}`
  );
  for (const current of variants) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each worktree is prepared sequentially to keep setup output and status transitions deterministic
    await updateVariant(current.kind, (status) => ({
      ...status,
      status: "preparing",
    }));
    // oxlint-disable-next-line eslint/no-await-in-loop -- git worktree mutations share repository metadata and must be serialized
    await run(
      "git",
      ["worktree", "add", "--detach", current.path, current.sha],
      {
        cwd: repositoryRoot,
      }
    );
    // oxlint-disable-next-line eslint/no-await-in-loop -- benchmark context must be installed only after its worktree exists
    await installBenchmarkContext(current.path);
  }

  await Promise.all(
    variants.map((current) =>
      run("pnpm", ["install", "--frozen-lockfile"], { cwd: current.path })
    )
  );

  await Promise.all(
    variants.map(async (current) => {
      current.databaseUrl = await startDatabase(current);
      await run("pnpm", ["db:migrate"], {
        cwd: current.path,
        env: databaseEnvironment(current.databaseUrl),
      });
      await run(
        join(repositoryRoot, "node_modules", ".bin", "tsx"),
        ["scripts/seed-browser-benchmark-vault.ts"],
        {
          cwd: current.path,
          env: databaseEnvironment(current.databaseUrl),
        }
      );
    })
  );

  await Promise.all(variants.map(startAgent));

  await updateLiveStatus((status) => ({ ...status, status: "running" }));

  const artifacts: Record<"baseline" | "candidate", string> = {
    baseline: "",
    candidate: "",
  };
  const results = await Promise.allSettled(
    variants.map(async (current) => {
      try {
        artifacts[current.kind] = await runBenchmark(current);
      } catch (error) {
        await updateVariant(current.kind, (status) => ({
          ...status,
          completedAt: new Date().toISOString(),
          error: errorMessageSchema.parse(error),
          status: "failed",
        }));
        throw error;
      }
    })
  );
  const failureMessages: string[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      failureMessages.push(errorMessageSchema.parse(result.reason));
    }
  }
  if (failureMessages.length > 0) {
    throw new Error(
      `One or more benchmark variants failed: ${failureMessages.join("; ")}`
    );
  }

  const manifest = {
    baseline: { artifact: artifacts.baseline, gitSha: baselineSha },
    candidate: { artifact: artifacts.candidate, gitSha: candidateSha },
    completedAt: new Date().toISOString(),
    label: options.label,
    repetitions: options.repetitions,
    suite: options.suite,
    taskTimeoutMs: options.taskTimeoutMs,
    version: 1,
  };
  await writeFile(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  await run(
    "node",
    [
      "--experimental-strip-types",
      "scripts/compare-browser-benchmarks.ts",
      artifacts.baseline,
      artifacts.candidate,
    ],
    { cwd: repositoryRoot }
  );

  await updateLiveStatus((status) => ({
    ...status,
    completedAt: new Date().toISOString(),
    status: "completed",
  }));
  await copyFile(liveStatusPath, join(outputDirectory, "status.json"));

  console.log(`A/B artifacts: ${outputDirectory}`);
  if (options.keep) {
    console.log(`Baseline: ${variants[0].url}`);
    console.log(`Candidate: ${variants[1].url}`);
  }
} catch (error) {
  if (liveStatusInitialized) {
    await updateLiveStatus((status) => ({
      ...status,
      completedAt: new Date().toISOString(),
      error: errorMessageSchema.parse(error),
      status: "failed",
    })).catch(() => undefined);
    await copyFile(liveStatusPath, join(outputDirectory, "status.json")).catch(
      () => undefined
    );
  }
  throw error;
} finally {
  await cleanup();
}

function variant(kind: "baseline" | "candidate", sha: string) {
  const suffix = `${shortSha(sha)}-${String(process.pid)}`;
  const name = `eve-browser-${kind}-${suffix}`;
  return {
    databaseUrl: "",
    kind,
    name,
    path: join(temporaryRoot, kind),
    sha,
    url: `https://${name}.localhost`,
  };
}

async function installBenchmarkContext(worktree: string) {
  const sourcePath = join(repositoryRoot, "agent", "channels", "eve.ts");
  const targetPath = join(worktree, "agent", "channels", "eve.ts");
  await copyFile(sourcePath, targetPath);
  await copyFile(
    join(repositoryRoot, "scripts", "seed-browser-benchmark-vault.ts"),
    join(worktree, "scripts", "seed-browser-benchmark-vault.ts")
  );
  await copyFile(
    join(repositoryRoot, ".env.local"),
    join(worktree, ".env.local")
  );
}

async function refreshGatewayEnvironment() {
  const commonGitDirectory = (
    await output(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd: repositoryRoot }
    )
  ).trim();
  const projectFile = join(
    dirname(commonGitDirectory),
    ".vercel",
    "project.json"
  );
  const project = z
    .object({ orgId: z.string().min(1), projectId: z.string().min(1) })
    .parse(JSON.parse(await readFile(projectFile, "utf8")));

  await run(
    "node_modules/eve/bin/eve.js",
    [
      "link",
      "--non-interactive",
      "--project",
      project.projectId,
      "--team",
      project.orgId,
    ],
    { cwd: repositoryRoot }
  );

  return {
    ...loadEnvConfig(repositoryRoot, true, console, true).combinedEnv,
    NODE_ENV: "development" as const,
  };
}

async function startDatabase(current: ReturnType<typeof variant>) {
  const maintenanceUrl = inheritedEnvironment.BROWSER_AB_DATABASE_BASE_URL;
  if (maintenanceUrl) {
    const name = `eve_browser_ab_${current.kind}_${hash(current.path).slice(0, 10)}`;
    await run(
      "dropdb",
      ["--if-exists", `--maintenance-db=${maintenanceUrl}`, name],
      { cwd: current.path }
    );
    await run("createdb", [`--maintenance-db=${maintenanceUrl}`, name], {
      cwd: current.path,
    });
    localDatabases.push({ maintenanceUrl, name });
    const databaseUrl = new URL(maintenanceUrl);
    databaseUrl.pathname = `/${name}`;
    return databaseUrl.toString();
  }

  const name = `browser-ab-${current.kind}-${hash(current.path).slice(0, 10)}`;
  composeProjects.push({ cwd: current.path, name });
  await run(
    "docker",
    ["compose", "--project-name", name, "up", "--detach", "--wait", "postgres"],
    { cwd: current.path }
  );
  const address = await output(
    "docker",
    ["compose", "--project-name", name, "port", "postgres", "5432"],
    { cwd: current.path }
  );
  const port = /:(\d+)\s*$/u.exec(address)?.[1];
  if (!port)
    throw new Error(`Could not resolve PostgreSQL port for ${current.kind}.`);
  return `postgresql://postgres:postgres@127.0.0.1:${port}/open_instinct`;
}

async function startAgent(current: ReturnType<typeof variant>) {
  const child = start(
    "portless",
    ["--name", current.name, "node_modules/eve/bin/eve.js", "dev", "--no-ui"],
    {
      cwd: current.path,
      env: {
        ...databaseEnvironment(current.databaseUrl),
        BETTER_AUTH_URL: current.url,
        EVE_DEV: "1",
        NODE_ENV: "development",
      },
    }
  );
  processes.push(child);
  await waitForUrl(`${current.url}/eve/v1/health`, child);
}

async function runBenchmark(current: ReturnType<typeof variant>) {
  const label = [
    options.label,
    current.kind,
    shortSha(current.sha),
    options.suite,
  ]
    .filter(Boolean)
    .join("-");
  const artifact = join(outputDirectory, `${current.kind}.json`);
  await run(
    "node_modules/eve/bin/eve.js",
    [
      "eval",
      "browser",
      "--url",
      current.url,
      "--strict",
      "--timeout",
      String(options.taskTimeoutMs),
      "--max-concurrency",
      String(options.maxConcurrency),
    ],
    {
      cwd: repositoryRoot,
      env: {
        BROWSER_BENCH_ARTIFACT_PATH: artifact,
        BROWSER_BENCH_LABEL: label,
        BROWSER_BENCH_RUN_ID: timestamp,
        BROWSER_BENCH_REPETITIONS: String(options.repetitions),
        BROWSER_BENCH_STATUS_PATH: liveStatusPath,
        BROWSER_BENCH_SUITE: options.suite,
        BROWSER_BENCH_VARIANT: current.kind,
        NODE_EXTRA_CA_CERTS:
          inheritedEnvironment.NODE_EXTRA_CA_CERTS ??
          join(homedir(), ".portless", "ca.pem"),
        NODE_ENV: "development",
      },
      validExitCodes: [0, 1],
    }
  );
  return artifact;
}

async function archivePreviousLiveStatus() {
  const previous = await readBrowserBenchmarkLiveStatus(liveStatusPath);
  if (!previous) return;
  const active =
    previous.status === "preparing" || previous.status === "running";
  await writeBrowserBenchmarkLiveStatus(
    join(previous.outputDirectory, "status.json"),
    active
      ? {
          ...previous,
          completedAt: new Date().toISOString(),
          error: "Superseded by a newer benchmark run.",
          status: "failed",
          updatedAt: new Date().toISOString(),
        }
      : previous
  );
}

function initialLiveStatus(
  variants: readonly ReturnType<typeof variant>[]
): BrowserBenchmarkLiveStatus {
  const startedAt = new Date().toISOString();
  const baseline = variants.find((current) => current.kind === "baseline");
  const candidate = variants.find((current) => current.kind === "candidate");
  if (!baseline || !candidate) throw new Error("A/B variants are incomplete.");

  const liveVariant = (current: ReturnType<typeof variant>) => ({
    completedAt: null,
    error: null,
    kind: current.kind,
    ref:
      current.kind === "baseline" ? options.baselineRef : options.candidateRef,
    sha: current.sha,
    startedAt: null,
    status: "pending" as const,
    tasks: [],
    url: current.url,
  });

  const status: BrowserBenchmarkLiveStatus = {
    completedAt: null,
    error: null,
    maxConcurrency: options.maxConcurrency,
    outputDirectory,
    repetitions: options.repetitions,
    runId: timestamp,
    startedAt,
    status: "preparing",
    suite: options.suite,
    taskTimeoutMs: options.taskTimeoutMs,
    updatedAt: startedAt,
    variants: {
      baseline: liveVariant(baseline),
      candidate: liveVariant(candidate),
    },
    version: 1,
  };
  if (options.label) status.label = options.label;
  return status;
}

async function updateLiveStatus(
  update: (status: BrowserBenchmarkLiveStatus) => BrowserBenchmarkLiveStatus
) {
  await updateBrowserBenchmarkLiveStatus(liveStatusPath, timestamp, update);
}

async function updateVariant(
  kind: "baseline" | "candidate",
  update: (
    status: BrowserBenchmarkLiveStatus["variants"][typeof kind]
  ) => BrowserBenchmarkLiveStatus["variants"][typeof kind]
) {
  await updateLiveStatus((status) => ({
    ...status,
    variants: {
      ...status.variants,
      [kind]: update(status.variants[kind]),
    },
  }));
}

async function waitForUrl(url: string, child: ChildProcess) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(
        `${basename(child.spawnfile)} exited before ${url} was ready.`
      );
    }
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- readiness retries must wait for the current probe to finish before backoff
      await run("curl", ["--fail", "--silent", "--show-error", url], {
        cwd: repositoryRoot,
      });
      return;
    } catch {
      // oxlint-disable-next-line eslint/no-await-in-loop -- bounded backoff intentionally serializes readiness probes
      await delay(1_000);
    }
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function databaseEnvironment(databaseUrl: string) {
  return {
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
    NODE_ENV: "development" as const,
  };
}

function start(
  command: string,
  args: string[],
  execution: { cwd: string; env?: NodeJS.ProcessEnv }
) {
  const child = spawn(command, args, {
    cwd: execution.cwd,
    detached: true,
    env: { ...inheritedEnvironment, ...execution.env },
    stdio: "inherit",
  });
  child.unref();
  return child;
}

async function run(
  command: string,
  args: string[],
  execution: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    validExitCodes?: number[];
  }
) {
  const child = spawn(command, args, {
    cwd: execution.cwd,
    env: { ...inheritedEnvironment, ...execution.env },
    stdio: "inherit",
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (!(execution.validExitCodes ?? [0]).includes(code ?? -1)) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${String(code)}.`
    );
  }
}

async function output(
  command: string,
  args: string[],
  execution: { cwd: string }
) {
  const child = spawn(command, args, {
    cwd: execution.cwd,
    env: inheritedEnvironment,
    stdio: ["ignore", "pipe", "inherit"],
  });
  child.stdout.setEncoding("utf8");
  let value = "";
  child.stdout.on("data", (chunk: string) => {
    value += chunk;
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`${command} exited with ${String(code)}.`);
  return value;
}

async function resolveCommit(reference: string) {
  return (
    await output("git", ["rev-parse", "--verify", `${reference}^{commit}`], {
      cwd: repositoryRoot,
    })
  ).trim();
}

async function cleanup() {
  if (keepResources) return;
  for (const child of processes.toReversed()) {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        const parsed = nodeErrorSchema.safeParse(error);
        if (!parsed.success || parsed.data.code !== "ESRCH") throw error;
      }
    }
  }
  for (const project of composeProjects.toReversed()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- teardown is deliberately ordered to avoid interleaved Docker cleanup
    await run(
      "docker",
      ["compose", "--project-name", project.name, "down", "--volumes"],
      { cwd: project.cwd }
    ).catch(() => undefined);
  }
  for (const database of localDatabases.toReversed()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- teardown is deliberately ordered to avoid interleaved database cleanup
    await run(
      "dropdb",
      [
        "--if-exists",
        "--force",
        `--maintenance-db=${database.maintenanceUrl}`,
        database.name,
      ],
      { cwd: repositoryRoot }
    ).catch(() => undefined);
  }
  for (const name of ["candidate", "baseline"]) {
    const path = join(temporaryRoot, name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- git worktree removals share repository metadata and must be serialized
    await run("git", ["worktree", "remove", "--force", path], {
      cwd: repositoryRoot,
    }).catch(() => undefined);
  }
  await rm(temporaryRoot, { force: true, recursive: true });
}

function parseArguments(args: string[]) {
  const positional: string[] = [];
  let suite: "all" | "live" | "smoke" = "smoke";
  let repetitions = 1;
  let maxConcurrency = 9;
  let taskTimeoutMs = 15 * 60_000;
  let keep = false;
  let label: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--keep") {
      keep = true;
      continue;
    }
    if (argument === "--suite") {
      const value = args[++index];
      if (value !== "all" && value !== "live" && value !== "smoke") {
        throw new Error("--suite must be smoke, live, or all.");
      }
      suite = value;
      continue;
    }
    if (argument === "--label") {
      const value = args[++index]?.trim();
      if (!value) throw new Error("--label requires a non-empty value.");
      label = value;
      continue;
    }
    if (argument === "--repetitions" || argument === "--max-concurrency") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 20) {
        throw new Error(`${argument} must be an integer from 1 to 20.`);
      }
      if (argument === "--repetitions") repetitions = value;
      else maxConcurrency = value;
      continue;
    }
    if (argument === "--task-timeout-minutes") {
      const value = Number(args[++index]);
      if (!Number.isInteger(value) || value < 1 || value > 60) {
        throw new Error(
          "--task-timeout-minutes must be an integer from 1 to 60."
        );
      }
      taskTimeoutMs = value * 60_000;
      continue;
    }
    if (argument?.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (argument) positional.push(argument);
  }

  const [baselineRef, candidateRef] = positional;
  if (positional.length !== 2 || !baselineRef || !candidateRef) {
    throw new Error(
      'Usage: pnpm bench:ab <baseline-ref> <candidate-ref> [--label "description"] [--suite smoke|live|all] [--repetitions n] [--max-concurrency n] [--task-timeout-minutes n] [--keep]'
    );
  }
  return {
    baselineRef,
    candidateRef,
    keep,
    label,
    maxConcurrency,
    repetitions,
    suite,
    taskTimeoutMs,
  };
}

function shortSha(sha: string) {
  return sha.slice(0, 12);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(milliseconds: number) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
