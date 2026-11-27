import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { DATASET_LOCKS } from "./datasets.ts";
import { forwardCredentials, runTrialPool } from "./pool.ts";
import type {
  BenchmarkRunOptions,
  HarnessBundle,
  HarnessName,
  LinuxArch,
  PrebuiltBundleManifest,
  TaskSpec,
  TrialResult,
} from "./types.ts";

const execFileAsync = promisify(execFile);

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const SANDBOX_CODE_DIR = "/opt/code-bench";
const SANDBOX_CACHE_DIR = "/opt/code-bench/cache";
const SANDBOX_BOOT_SCRIPT = "/opt/code-bench/boot-sandbox.sh";
const SANDBOX_VCPUS = 4;
const SANDBOX_TRIAL_TIMEOUT_MS = 60 * 60 * 1000;

const INSTALL_DOCKER_SH = `#!/usr/bin/env bash
set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
fi
mkdir -p /vercel/sandbox
chown "$(stat -c %u:%g /vercel)" /vercel/sandbox
`;

const BOOT_SANDBOX_SH = `#!/usr/bin/env bash
set -euo pipefail
root=/sys/fs/cgroup
if [ -f "$root/cgroup.controllers" ] && [ -z "$(cat "$root/cgroup.subtree_control")" ]; then
  mkdir -p "$root/init"
  for _ in $(seq 1 20); do
    for pid in $(cat "$root/cgroup.procs"); do
      echo "$pid" > "$root/init/cgroup.procs" 2>/dev/null || true
    done
    [ -z "$(cat "$root/cgroup.procs")" ] && break
    sleep 0.5
  done
  for controller in $(cat "$root/cgroup.controllers"); do
    echo "+$controller" > "$root/cgroup.subtree_control" 2>/dev/null || true
  done
fi
if ! docker info >/dev/null 2>&1; then
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 0.5
  done
fi
if ! docker info >/dev/null 2>&1; then
  echo "dockerd failed to start:" >&2
  cat /tmp/dockerd.log >&2 || true
  exit 1
fi
`;

interface SandboxCredentials {
  readonly token?: string;
  readonly teamId?: string;
  readonly projectId?: string;
}

interface ManagedSandbox {
  stop(): Promise<unknown>;
  delete(opts?: { deleteOrphanSnapshots?: boolean }): Promise<unknown>;
}

function sandboxCredentials(): SandboxCredentials {
  const creds: { token?: string; teamId?: string; projectId?: string } = {};
  if (process.env.VERCEL_TOKEN) creds.token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID ?? process.env.VERCEL_ORG_ID;
  if (teamId) creds.teamId = teamId;
  if (process.env.VERCEL_PROJECT_ID) creds.projectId = process.env.VERCEL_PROJECT_ID;
  return creds;
}

async function createWithRetry<T>(fn: () => Promise<T>, maxRetries = 8): Promise<T> {
  let delayMs = 2_000;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt >= maxRetries || !/429|rate.?limit/iu.test(msg)) throw error;
      const jitter = Math.floor(Math.random() * 1_000);
      await new Promise((r) => setTimeout(r, delayMs + jitter));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}

async function createTarGz(cwd: string, entries: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("tar", ["-czf", "-", "-C", cwd, ...entries], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
  });
  return stdout;
}

async function cleanupSandbox(
  sandbox: ManagedSandbox,
  deleteOrphanSnapshots: boolean,
): Promise<void> {
  await sandbox.stop().catch(() => {});
  await sandbox.delete({ deleteOrphanSnapshots }).catch(() => {});
}

async function prepareTemplateSnapshot(options: {
  readonly runOptions: BenchmarkRunOptions;
  readonly cacheDir: string;
  readonly nodeDirs: Readonly<Record<LinuxArch, string>>;
  readonly bundles: ReadonlyMap<HarnessName, HarnessBundle>;
  readonly creds: SandboxCredentials;
}) {
  const { Sandbox } = await import("@vercel/sandbox");
  const { runOptions, cacheDir, nodeDirs, bundles, creds } = options;

  const lock = DATASET_LOCKS[runOptions.dataset];
  const datasetRelDir = join("datasets", `${runOptions.dataset}-${lock.commit.slice(0, 12)}`);
  const nodeX64Rel = relative(cacheDir, nodeDirs.x64);

  const tarEntries = new Set<string>([datasetRelDir, nodeX64Rel, "bundles.json"]);
  const manifestBundles: PrebuiltBundleManifest["bundles"] = {};

  for (const [harness, bundle] of bundles) {
    const bundleRelDir = bundle.dir ? relative(cacheDir, bundle.dir) : undefined;
    const archX64Rel = bundle.archDirs?.x64 ? relative(cacheDir, bundle.archDirs.x64) : undefined;
    if (bundleRelDir) tarEntries.add(bundleRelDir);
    if (archX64Rel) tarEntries.add(archX64Rel);
    manifestBundles[harness] = {
      harness,
      version: bundle.version,
      bundleRelDir,
      archRelDirs: archX64Rel ? { x64: archX64Rel } : undefined,
    };
  }

  const manifest: PrebuiltBundleManifest = {
    nodeRelDirs: { x64: nodeX64Rel },
    bundles: manifestBundles,
  };
  await writeFile(join(cacheDir, "bundles.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const template = await createWithRetry(() =>
    Sandbox.create({
      ...creds,
      image: "vercel/sandbox/universal:latest",
      persistent: false,
      resources: { vcpus: SANDBOX_VCPUS },
      timeout: 30 * 60 * 1000,
    }),
  );

  try {
    await template.runCommand({ cmd: "mkdir", args: ["-p", SANDBOX_CACHE_DIR], sudo: true });
    await template.writeFiles([
      { path: "/tmp/install-docker.sh", content: Buffer.from(INSTALL_DOCKER_SH) },
      { path: "/tmp/boot-sandbox.sh", content: Buffer.from(BOOT_SANDBOX_SH) },
    ]);
    const installRes = await template.runCommand({
      cmd: "bash",
      args: [
        "-c",
        `mv /tmp/boot-sandbox.sh ${SANDBOX_BOOT_SCRIPT} && chmod +x ${SANDBOX_BOOT_SCRIPT} && bash /tmp/install-docker.sh`,
      ],
      sudo: true,
    });
    if (installRes.exitCode !== 0) {
      throw new Error(`Failed to install docker in sandbox template: ${await installRes.stderr()}`);
    }

    const runnerTar = await createTarGz(THIS_DIR, ["."]);
    const cacheTar = await createTarGz(cacheDir, [...tarEntries]);
    await template.writeFiles([
      { path: "/tmp/runner.tar.gz", content: runnerTar },
      { path: "/tmp/cache.tar.gz", content: cacheTar },
    ]);
    const unpackRes = await template.runCommand({
      cmd: "bash",
      args: [
        "-c",
        `printf '%s\\n' '{"type":"module"}' > ${SANDBOX_CODE_DIR}/package.json && tar -xzf /tmp/runner.tar.gz -C ${SANDBOX_CODE_DIR} && tar -xzf /tmp/cache.tar.gz -C ${SANDBOX_CACHE_DIR} && rm -f /tmp/runner.tar.gz /tmp/cache.tar.gz`,
      ],
      sudo: true,
    });
    if (unpackRes.exitCode !== 0) {
      throw new Error(`Failed to unpack benchmark assets in template: ${await unpackRes.stderr()}`);
    }

    return await template.snapshot({ expiration: 24 * 60 * 60 * 1000 });
  } finally {
    await cleanupSandbox(template, false);
  }
}

async function runSingleTrialInSandbox(options: {
  readonly snapshotId: string;
  readonly runOptions: BenchmarkRunOptions;
  readonly harness: HarnessName;
  readonly task: TaskSpec;
  readonly attempt: number;
  readonly trialDir: string;
  readonly forwardEnv: Readonly<Record<string, string>>;
  readonly creds: SandboxCredentials;
  readonly activeSandboxes: Set<ManagedSandbox>;
}): Promise<TrialResult> {
  const { Sandbox } = await import("@vercel/sandbox");
  const {
    snapshotId,
    runOptions,
    harness,
    task,
    attempt,
    trialDir,
    forwardEnv,
    creds,
    activeSandboxes,
  } = options;
  const startedAt = new Date().toISOString();
  await mkdir(trialDir, { recursive: true });

  let sandbox: (Awaited<ReturnType<typeof Sandbox.create>> & ManagedSandbox) | null = null;
  try {
    sandbox = await createWithRetry(() =>
      Sandbox.create({
        ...creds,
        source: { type: "snapshot", snapshotId },
        persistent: false,
        resources: { vcpus: SANDBOX_VCPUS },
        timeout: SANDBOX_TRIAL_TIMEOUT_MS,
      }),
    );
    activeSandboxes.add(sandbox);

    const bootRes = await sandbox.runCommand({
      cmd: "bash",
      args: [SANDBOX_BOOT_SCRIPT],
      sudo: true,
    });
    if (bootRes.exitCode !== 0) {
      throw new Error(`Sandbox Docker boot failed: ${await bootRes.stderr()}`);
    }

    const remoteOut = "/tmp/trial-out";
    const workerRes = await sandbox.runCommand({
      cmd: "node",
      args: [
        join(SANDBOX_CODE_DIR, "cli.ts"),
        "--worker",
        "--dataset",
        runOptions.dataset,
        "--harness",
        harness,
        "--task",
        task.name,
        "--attempt",
        String(attempt),
        "--model",
        runOptions.model,
        "--reasoning",
        runOptions.reasoning,
        "--cache",
        SANDBOX_CACHE_DIR,
        "--output",
        remoteOut,
      ],
      env: forwardEnv,
      sudo: true,
    });

    await sandbox.runCommand({
      cmd: "bash",
      args: ["-c", `tar -czf /tmp/trial-out.tar.gz -C ${remoteOut} . 2>/dev/null || true`],
      sudo: true,
    });
    const tarBuf = await sandbox.readFileToBuffer({ path: "/tmp/trial-out.tar.gz" });
    if (tarBuf && tarBuf.length > 0) {
      const localTar = join(trialDir, ".trial-out.tar.gz");
      await writeFile(localTar, tarBuf);
      try {
        await execFileAsync("tar", ["-xzf", localTar, "-C", trialDir]);
      } finally {
        await rm(localTar, { force: true }).catch(() => {});
      }
    }

    try {
      return JSON.parse(await readFile(join(trialDir, "trial.json"), "utf8")) as TrialResult;
    } catch {
      const stderr = await workerRes.stderr().catch(() => "");
      throw new Error(
        `Worker did not produce trial.json (exit ${workerRes.exitCode}): ${stderr.slice(0, 600)}`,
      );
    }
  } catch (err) {
    const failed: TrialResult = {
      task: task.name,
      attempt,
      harness,
      model: runOptions.model,
      reward: null,
      agent: { status: "failed", exitCode: 1, durationMs: 0 },
      verifier: { status: "skipped", exitCode: 1, durationMs: 0 },
      error: err instanceof Error ? err.message : String(err),
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(join(trialDir, "trial.json"), `${JSON.stringify(failed, null, 2)}\n`);
    return failed;
  } finally {
    if (sandbox) {
      activeSandboxes.delete(sandbox);
      await cleanupSandbox(sandbox, true);
    }
  }
}

export async function runOnVercelSandboxes(options: {
  readonly runOptions: BenchmarkRunOptions;
  readonly tasks: readonly TaskSpec[];
  readonly cacheDir: string;
  readonly nodeDirs: Readonly<Record<LinuxArch, string>>;
  readonly bundles: ReadonlyMap<HarnessName, HarnessBundle>;
  readonly onTrialComplete?: (completed: readonly TrialResult[]) => Promise<void>;
}): Promise<TrialResult[]> {
  const creds = sandboxCredentials();
  const forwardEnv = forwardCredentials();
  const absCache = resolve(options.cacheDir);
  const activeSandboxes = new Set<ManagedSandbox>();

  console.log(
    "Preparing Vercel Sandbox template snapshot (Docker + datasets + harness bundles)...",
  );
  const snap = await prepareTemplateSnapshot({
    runOptions: options.runOptions,
    cacheDir: absCache,
    nodeDirs: options.nodeDirs,
    bundles: options.bundles,
    creds,
  });
  console.log(`Template snapshot ready: ${snap.snapshotId}`);

  let cleaningUp = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (cleaningUp) return;
    cleaningUp = true;
    const active = [...activeSandboxes];
    activeSandboxes.clear();
    void Promise.allSettled([
      ...active.map((sb) => cleanupSandbox(sb, true)),
      snap.delete().catch(() => {}),
    ]).finally(() => {
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    return await runTrialPool({
      runOptions: options.runOptions,
      tasks: options.tasks,
      onTrialComplete: options.onTrialComplete,
      execute: (job) =>
        runSingleTrialInSandbox({
          snapshotId: snap.snapshotId,
          runOptions: options.runOptions,
          harness: job.harness,
          task: job.task,
          attempt: job.attempt,
          trialDir: job.trialDir,
          forwardEnv,
          creds,
          activeSandboxes,
        }),
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await snap.delete().catch(() => {});
  }
}
