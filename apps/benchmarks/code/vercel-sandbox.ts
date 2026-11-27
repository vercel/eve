import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Sandbox } from "@vercel/sandbox";

import type {
  BenchmarkRunOptions,
  HarnessBundle,
  HarnessName,
  PrebuiltBundleManifest,
  TaskSpec,
  TrialResult,
} from "./types.ts";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BENCHMARKS_DIR = resolve(here, "..");

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
docker info >/dev/null 2>&1
`;

interface SandboxCredentials {
  readonly token?: string;
  readonly teamId?: string;
  readonly projectId?: string;
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
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt >= maxRetries || !/429|rate.?limit/iu.test(msg)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, delayMs));
      delayMs = Math.min(delayMs * 2, 60_000);
    }
  }
}

export async function runOnVercelSandboxes(input: {
  readonly options: BenchmarkRunOptions;
  readonly tasks: readonly TaskSpec[];
  readonly bundles: ReadonlyMap<HarnessName, HarnessBundle>;
  readonly cacheDir: string;
}): Promise<TrialResult[]> {
  const { options, tasks, bundles, cacheDir } = input;
  const creds = sandboxCredentials();
  const vcpus = options.vcpus ?? 4;

  const manifest: PrebuiltBundleManifest = {};
  for (const [harness, bundle] of bundles) {
    manifest[harness] = {
      harness,
      version: bundle.version,
      bundleRelDir: relative(cacheDir, bundle.dir),
      archRelDirs: bundle.archDirs
        ? {
            x64: relative(cacheDir, bundle.archDirs.x64),
            arm64: relative(cacheDir, bundle.archDirs.arm64),
          }
        : undefined,
    };
  }
  await writeFile(join(cacheDir, "bundles.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log("[code-bench] Preparing Vercel Sandbox template with Docker & prebuilt bundles...");
  const template = await createWithRetry(() =>
    Sandbox.create({
      image: "vercel/sandbox/universal:latest",
      resources: { vcpus },
      timeout: 30 * 60 * 1000,
      ...creds,
    }),
  );

  let snapshot: Awaited<ReturnType<Sandbox["snapshot"]>> | undefined;
  const results: TrialResult[] = [];

  try {
    await template.writeFiles([
      { path: "/tmp/install-docker.sh", content: Buffer.from(INSTALL_DOCKER_SH) },
      { path: "/tmp/boot-sandbox.sh", content: Buffer.from(BOOT_SANDBOX_SH) },
    ]);
    const installRes = await template.runCommand({
      cmd: "bash",
      args: ["/tmp/install-docker.sh"],
      sudo: true,
    });
    if (installRes.exitCode !== 0) {
      throw new Error(`Template docker install failed: ${await installRes.stderr()}`);
    }

    const codeTarPath = join(options.outputDir, ".code-payload.tar.gz");
    const cacheTarPath = join(options.outputDir, ".cache-payload.tar.gz");
    try {
      await exec("tar", ["-czf", codeTarPath, "-C", BENCHMARKS_DIR, "code"], {
        maxBuffer: 32 * 1024 * 1024,
      });
      await exec("tar", ["-czf", cacheTarPath, "-C", cacheDir, "."], {
        maxBuffer: 32 * 1024 * 1024,
      });
      const [codeArchive, cacheArchive] = await Promise.all([
        readFile(codeTarPath),
        readFile(cacheTarPath),
      ]);

      await template.runCommand({
        cmd: "mkdir",
        args: ["-p", "/opt/code-bench/cache"],
        sudo: true,
      });
      await template.writeFiles([
        { path: "/tmp/code.tar.gz", content: codeArchive },
        { path: "/tmp/cache.tar.gz", content: cacheArchive },
      ]);
    } finally {
      await rm(codeTarPath, { force: true });
      await rm(cacheTarPath, { force: true });
    }

    const unpackRes = await template.runCommand({
      cmd: "sh",
      args: [
        "-c",
        'printf \'{"type":"module"}\\n\' > /opt/code-bench/package.json && tar -xzf /tmp/code.tar.gz -C /opt/code-bench && tar -xzf /tmp/cache.tar.gz -C /opt/code-bench/cache && rm -f /tmp/code.tar.gz /tmp/cache.tar.gz',
      ],
      sudo: true,
    });
    if (unpackRes.exitCode !== 0) {
      throw new Error(`Template payload unpack failed: ${await unpackRes.stderr()}`);
    }

    snapshot = await template.snapshot({ expiration: 24 * 60 * 60 * 1000 });
    console.log(`[code-bench] Snapshot ready: ${snapshot.snapshotId}`);

    const queue: Array<{ harness: HarnessName; task: TaskSpec; attempt: number }> = [];
    for (const harness of options.harnesses) {
      for (const task of tasks) {
        for (let attempt = 1; attempt <= options.attempts; attempt++) {
          queue.push({ harness, task, attempt });
        }
      }
    }

    const total = queue.length;
    let nextIdx = 0;
    let done = 0;

    const worker = async () => {
      while (nextIdx < queue.length) {
        const job = queue[nextIdx++]!;
        const trialDir = join(
          options.outputDir,
          "trials",
          job.harness,
          job.task.name,
          String(job.attempt),
        );
        await mkdir(trialDir, { recursive: true });
        const result = await runSingleSandboxTrial({
          snapshotId: snapshot!.snapshotId,
          creds,
          vcpus,
          options,
          job,
          trialDir,
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
  } finally {
    await snapshot?.delete().catch(() => {});
    await template.stop().catch(() => {});
  }

  return results;
}

async function runSingleSandboxTrial(input: {
  readonly snapshotId: string;
  readonly creds: SandboxCredentials;
  readonly vcpus: number;
  readonly options: BenchmarkRunOptions;
  readonly job: {
    readonly harness: HarnessName;
    readonly task: TaskSpec;
    readonly attempt: number;
  };
  readonly trialDir: string;
}): Promise<TrialResult> {
  const { snapshotId, creds, vcpus, options, job, trialDir } = input;
  const startedAt = new Date().toISOString();
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await createWithRetry(() =>
      Sandbox.create({
        source: { type: "snapshot", snapshotId },
        resources: { vcpus },
        timeout: 45 * 60 * 1000,
        ...creds,
      }),
    );

    const boot = await sandbox.runCommand({
      cmd: "bash",
      args: ["/tmp/boot-sandbox.sh"],
      sudo: true,
    });
    if (boot.exitCode !== 0) {
      throw new Error(`Sandbox Docker boot failed: ${await boot.stderr()}`);
    }

    const forwardEnv: Record<string, string> = {};
    for (const key of ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      if (process.env[key]) forwardEnv[key] = process.env[key]!;
    }

    const run = await sandbox.runCommand({
      cmd: "node",
      args: [
        "/opt/code-bench/code/cli.ts",
        "--worker",
        "--dataset",
        options.dataset,
        "--harness",
        job.harness,
        "--task",
        job.task.name,
        "--attempt",
        String(job.attempt),
        "--model",
        options.model,
        "--reasoning",
        options.reasoning,
        "--cache-dir",
        "/opt/code-bench/cache",
        "--output",
        "/tmp/trial-out",
      ],
      env: forwardEnv,
      sudo: true,
    });

    await sandbox.runCommand({
      cmd: "tar",
      args: ["-czf", "/tmp/trial-out.tar.gz", "-C", "/tmp/trial-out", "."],
      sudo: true,
    });
    const archiveBuf = await sandbox.readFileToBuffer({ path: "/tmp/trial-out.tar.gz" });
    if (archiveBuf) {
      const localTar = join(trialDir, ".download.tar.gz");
      await writeFile(localTar, archiveBuf);
      await exec("tar", ["-xzf", localTar, "-C", trialDir]);
      await rm(localTar, { force: true });
    }

    const trialJson = await readFile(join(trialDir, "trial.json"), "utf8").catch(() => undefined);
    if (trialJson) {
      return JSON.parse(trialJson) as TrialResult;
    }
    throw new Error(
      `Worker exited ${run.exitCode} without trial.json: ${(await run.stderr()).slice(0, 400)}`,
    );
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    const failed: TrialResult = {
      task: job.task.name,
      attempt: job.attempt,
      harness: job.harness,
      model: options.model,
      reward: null,
      agent: { status: "failed", exitCode: null, durationMs: 0 },
      verifier: { status: "skipped", exitCode: null, durationMs: 0 },
      error: message,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(join(trialDir, "trial.json"), `${JSON.stringify(failed, null, 2)}\n`);
    return failed;
  } finally {
    await sandbox?.stop().catch(() => {});
  }
}
