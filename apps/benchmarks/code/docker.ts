import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

import type {
  AgentOutcome,
  HarnessBundle,
  LinuxArch,
  TaskSpec,
  TokenUsage,
  TrialOverhead,
  TrialResult,
  VerifierOutcome,
} from "./types.ts";

const execFileAsync = promisify(execFile);

const INSTALL_DIR = "/installed-agent";
const TASK_DIR = "/task";
const TESTS_DIR = "/tests";
const LOGS_DIR = "/logs";
const PEER_RUNNER_SRC = join(dirname(fileURLToPath(import.meta.url)), "harnesses/peer-runner.mjs");
const MAX_CONTAINER_COPY_FILES = 1_000;
const MAX_CONTAINER_COPY_BYTES = 64 * 1024 * 1024;

const dockerCmd = (args: readonly string[], timeoutMs = 120_000) =>
  execFileAsync("docker", [...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });

async function killContainerPidFile(container: string, pidFile: string): Promise<void> {
  const script = `pid=$(cat '${pidFile}' 2>/dev/null); if [ -n "$pid" ]; then kill -TERM -- -"$pid" "$pid" 2>/dev/null || true; sleep 1; kill -KILL -- -"$pid" "$pid" 2>/dev/null || true; fi; rm -f '${pidFile}'`;
  await dockerCmd(["exec", container, "sh", "-c", script], 15_000).catch(() => {});
}

async function execInContainer(options: {
  readonly container: string;
  readonly command: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly logPath?: string;
}): Promise<{ exitCode: number; timedOut: boolean; durationMs: number }> {
  const startedAt = Date.now();
  const pidFile = `/tmp/.code-bench-pid-${randomUUID().slice(0, 8)}`;
  const args = [
    "exec",
    ...Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  ];
  const wrapped = `echo $$ > '${pidFile}'; trap 'rm -f "${pidFile}"' EXIT; ${options.command}`;
  args.push(options.container, "sh", "-c", wrapped);

  const logStream = options.logPath ? createWriteStream(options.logPath) : null;
  logStream?.on("error", () => {});
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  if (logStream) {
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
  } else {
    child.stdout.resume();
    child.stderr.resume();
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void killContainerPidFile(options.container, pidFile).finally(() => child.kill("SIGKILL"));
  }, options.timeoutMs);

  const exitCode = await new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  clearTimeout(timer);
  if (timedOut) await killContainerPidFile(options.container, pidFile);
  if (logStream) {
    logStream.end();
    await finished(logStream).catch(() => {});
  }
  return { exitCode: timedOut ? 124 : exitCode, timedOut, durationMs: Date.now() - startedAt };
}

export async function streamToFileWithLimit(
  source: NodeJS.ReadableStream,
  destPath: string,
  maxBytes: number,
  onLimit?: () => void,
): Promise<number> {
  await mkdir(dirname(destPath), { recursive: true });
  const out = createWriteStream(destPath);
  let totalBytes = 0;
  let exceeded = false;
  try {
    for await (const rawChunk of source) {
      const chunk = typeof rawChunk === "string" ? Buffer.from(rawChunk) : Buffer.from(rawChunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        exceeded = true;
        onLimit?.();
        if ("destroy" in source && typeof source.destroy === "function") {
          source.destroy();
        }
        throw new RangeError(`Transfer exceeded ${maxBytes} byte limit`);
      }
      if (!out.write(chunk)) {
        await new Promise<void>((resolveDrain, rejectDrain) => {
          out.once("drain", resolveDrain);
          out.once("error", rejectDrain);
        });
      }
    }
    out.end();
    await finished(out);
    return totalBytes;
  } catch (err) {
    out.destroy();
    await rm(destPath, { force: true }).catch(() => {});
    if (exceeded && err instanceof RangeError) throw err;
    throw err;
  }
}

function parseTarOctalOrBase256(buf: Buffer): number {
  if (buf.length > 0 && (buf[0]! & 0x80) !== 0) {
    let val = 0;
    for (let i = 1; i < buf.length; i++) val = val * 256 + buf[i]!;
    return val;
  }
  const str = buf.toString("ascii").replace(/\0.*$/u, "").trim();
  return str ? Number.parseInt(str, 8) : 0;
}

function readCString(buf: Buffer): string {
  const zero = buf.indexOf(0);
  return (zero === -1 ? buf : buf.subarray(0, zero)).toString("utf8");
}

function parsePaxRecords(data: Buffer): { size?: number; path?: string; hasSparse: boolean } {
  let offset = 0;
  let size: number | undefined;
  let path: string | undefined;
  let hasSparse = false;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const len = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    if (!Number.isFinite(len) || len <= 0 || offset + len > data.length) break;
    const record = data
      .subarray(space + 1, offset + len)
      .toString("utf8")
      .replace(/\n$/u, "");
    const eq = record.indexOf("=");
    if (eq !== -1) {
      const key = record.slice(0, eq);
      const value = record.slice(eq + 1);
      if (key.startsWith("GNU.sparse.") || key.startsWith("SCHILY.sparse.")) hasSparse = true;
      else if (key === "linkpath") {
        throw new RangeError("Archive contains disallowed PAX linkpath");
      } else if (key === "size") {
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 0) {
          throw new RangeError("Archive contains invalid PAX size");
        }
        size = parsed;
      } else if (key === "path") {
        path = value;
      }
    }
    offset += len;
  }
  return { size, path, hasSparse };
}

async function inspectBoundedTar(
  tarPath: string,
  options: {
    readonly gzip: boolean;
    readonly maxFiles: number;
    readonly maxUncompressedBytes: number;
  },
): Promise<void> {
  if (!options.gzip) {
    const size = (await stat(tarPath)).size;
    if (size > options.maxUncompressedBytes) {
      throw new RangeError(
        `Archive exceeded ${options.maxUncompressedBytes} uncompressed byte limit`,
      );
    }
  }

  const input = createReadStream(tarPath);
  const stream = options.gzip ? input.pipe(createGunzip()) : input;

  let streamBytes = 0;
  let logicalBytes = 0;
  let entryCount = 0;
  let pending: Buffer = Buffer.alloc(0);
  let skipBytes = 0;
  let captureKind: "pax" | "gnu-long" | null = null;
  let captureRemaining = 0;
  let captureChunks: Buffer[] = [];
  let capturePad = 0;
  let nextPax: { size?: number; path?: string } | null = null;
  let nextGnuPath: string | null = null;

  const consumeBlocks = () => {
    for (;;) {
      if (captureKind !== null) {
        if (captureRemaining > 0) {
          if (pending.length === 0) return;
          const take = Math.min(pending.length, captureRemaining);
          captureChunks.push(pending.subarray(0, take));
          pending = pending.subarray(take);
          captureRemaining -= take;
          if (captureRemaining > 0) return;
        }
        if (capturePad > 0) {
          if (pending.length < capturePad) return;
          pending = pending.subarray(capturePad);
          capturePad = 0;
        }
        const payload = Buffer.concat(captureChunks);
        captureChunks = [];
        if (captureKind === "pax") {
          const pax = parsePaxRecords(payload);
          if (pax.hasSparse) {
            throw new RangeError("Archive contains disallowed sparse entry");
          }
          nextPax = { size: pax.size, path: pax.path };
        } else {
          nextGnuPath = readCString(payload);
        }
        captureKind = null;
        continue;
      }

      if (skipBytes > 0) {
        if (pending.length === 0) return;
        const drop = Math.min(pending.length, skipBytes);
        pending = pending.subarray(drop);
        skipBytes -= drop;
        if (skipBytes > 0) return;
      }

      if (pending.length < 512) return;
      const header = pending.subarray(0, 512);
      pending = pending.subarray(512);

      let allZero = true;
      for (let i = 0; i < 512; i++) {
        if (header[i] !== 0) {
          allZero = false;
          break;
        }
      }
      if (allZero) continue;

      const typeByte = header[156]!;
      const typeChar = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
      const rawDataSize = parseTarOctalOrBase256(header.subarray(124, 136));
      if (!Number.isFinite(rawDataSize) || rawDataSize < 0) {
        throw new RangeError("Archive contains invalid entry size");
      }
      const paddedDataSize = Math.ceil(rawDataSize / 512) * 512;

      if (typeChar === "x" || typeChar === "L") {
        if (rawDataSize > 1024 * 1024) {
          throw new RangeError("Archive metadata header exceeds 1 MiB limit");
        }
        captureKind = typeChar === "L" ? "gnu-long" : "pax";
        captureRemaining = rawDataSize;
        capturePad = paddedDataSize - rawDataSize;
        captureChunks = [];
        continue;
      }

      if (typeChar !== "0" && typeChar !== "5") {
        throw new RangeError(`Archive contains disallowed entry type '${typeChar}'`);
      }

      if (nextPax?.size !== undefined && nextPax.size !== rawDataSize) {
        throw new RangeError("Archive contains mismatched PAX size override");
      }

      const name = readCString(header.subarray(0, 100));
      const prefix = readCString(header.subarray(345, 500));
      const entryPath = nextPax?.path ?? nextGnuPath ?? (prefix ? `${prefix}/${name}` : name);
      const logicalSize = rawDataSize;
      nextPax = null;
      nextGnuPath = null;

      entryCount += 1;
      if (entryCount > options.maxFiles) {
        throw new RangeError(`Archive exceeded ${options.maxFiles} entry limit`);
      }
      if (entryPath.startsWith("/") || entryPath.split("/").includes("..")) {
        throw new RangeError(`Archive contains unsafe path: ${entryPath}`);
      }
      logicalBytes += logicalSize;
      if (logicalBytes > options.maxUncompressedBytes) {
        throw new RangeError(
          `Archive exceeded ${options.maxUncompressedBytes} uncompressed byte limit`,
        );
      }

      skipBytes = paddedDataSize;
    }
  };

  try {
    for await (const rawChunk of stream) {
      const chunk = rawChunk as Buffer;
      streamBytes += chunk.length;
      if (streamBytes > options.maxUncompressedBytes) {
        throw new RangeError(
          `Archive exceeded ${options.maxUncompressedBytes} uncompressed byte limit`,
        );
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      consumeBlocks();
    }
    if (captureKind !== null || skipBytes > 0) {
      throw new RangeError("Archive is truncated");
    }
  } catch (err) {
    input.destroy();
    if (stream !== input) stream.destroy();
    throw err;
  }
}

export async function extractBoundedTar(
  tarPath: string,
  destDir: string,
  options: {
    readonly gzip: boolean;
    readonly maxFiles: number;
    readonly maxUncompressedBytes: number;
  },
): Promise<void> {
  await inspectBoundedTar(tarPath, options);
  await mkdir(destDir, { recursive: true });
  const extractFlag = options.gzip ? "-xzf" : "-xf";
  await execFileAsync("tar", ["--no-same-owner", extractFlag, tarPath, "-C", destDir], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

const copyInto = (src: string, container: string, dest: string) =>
  dockerCmd(["cp", src, `${container}:${dest}`], 120_000);

async function copyFrom(container: string, src: string, dest: string): Promise<boolean> {
  const tempTar = join(dirname(dest), `.copy-${randomUUID().slice(0, 8)}.tar`);
  const child = spawn("docker", ["cp", `${container}:${src}/.`, "-"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.resume();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 120_000);
  const exitPromise = new Promise<number>((resolveExit) => {
    child.once("close", (code) => resolveExit(code ?? 1));
    child.once("error", () => resolveExit(1));
  });
  try {
    const bytes = await streamToFileWithLimit(
      child.stdout,
      tempTar,
      MAX_CONTAINER_COPY_BYTES,
      () => {
        child.kill("SIGKILL");
      },
    );
    const exitCode = await exitPromise;
    if (timedOut) {
      throw new Error(`Timed out copying ${src} from container`);
    }
    if (exitCode !== 0 || bytes === 0) {
      return false;
    }
    await extractBoundedTar(tempTar, dest, {
      gzip: false,
      maxFiles: MAX_CONTAINER_COPY_FILES,
      maxUncompressedBytes: MAX_CONTAINER_COPY_BYTES,
    });
    return true;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exitPromise;
    await rm(tempTar, { force: true }).catch(() => {});
  }
}

async function ensureTaskImage(task: TaskSpec): Promise<{ image: string; builtLocally: boolean }> {
  if (task.dockerImage) {
    await dockerCmd(["pull", task.dockerImage], 600_000);
    return { image: task.dockerImage, builtLocally: false };
  }
  const tag = `code-bench-${task.name}:${randomUUID().slice(0, 8)}`;
  await dockerCmd(["build", "-t", tag, task.environmentDir], 600_000);
  return { image: tag, builtLocally: true };
}

async function startContainer(
  task: TaskSpec,
  image: string,
  networkNone: boolean,
): Promise<string> {
  const args = [
    "run",
    "-d",
    "--init",
    "--entrypoint",
    "",
    "--cpus",
    String(task.cpus),
    "--memory",
    `${task.memoryMb}m`,
    ...(networkNone ? ["--network", "none"] : []),
    image,
    "sh",
    "-c",
    "trap 'exit 0' TERM INT; while :; do sleep 3600 & wait $!; done",
  ];
  return (await dockerCmd(args, 60_000)).stdout.trim();
}

export function parseRewardText(raw: string): { reward: number | null; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { reward: null, error: "verifier wrote empty reward.txt" };
  const num = Number(trimmed);
  if (!Number.isFinite(num))
    return { reward: null, error: `verifier wrote non-numeric reward.txt: ${trimmed}` };
  if (num < 0) return { reward: null, error: `verifier exited with crash sentinel (${num})` };
  if (num > 1) return { reward: null, error: `verifier wrote out-of-range reward (${num})` };
  return { reward: num };
}

async function readBoundedUtf8(filePath: string, maxBytes: number): Promise<string> {
  const info = await stat(filePath);
  if (info.size > maxBytes) {
    throw new RangeError(`${filePath} exceeded ${maxBytes} byte read limit`);
  }
  return await readFile(filePath, "utf8");
}

async function readReward(verifierDir: string): Promise<{ reward: number | null; error?: string }> {
  try {
    return parseRewardText(await readBoundedUtf8(join(verifierDir, "reward.txt"), 64 * 1024));
  } catch (err) {
    if (err instanceof RangeError) return { reward: null, error: err.message };
  }
  try {
    const raw = JSON.parse(await readBoundedUtf8(join(verifierDir, "reward.json"), 64 * 1024)) as {
      reward?: unknown;
    };
    if (typeof raw.reward === "number" && Number.isFinite(raw.reward)) {
      return parseRewardText(String(raw.reward));
    }
  } catch (err) {
    if (err instanceof RangeError) return { reward: null, error: err.message };
  }
  return { reward: null };
}

async function readAgentTelemetry(agentDir: string): Promise<{
  usage?: TokenUsage;
  overhead?: TrialOverhead;
  status?: AgentOutcome["status"];
  error?: string;
}> {
  try {
    const parsed = JSON.parse(
      await readBoundedUtf8(join(agentDir, "result.json"), 4 * 1024 * 1024),
    ) as Record<string, unknown>;
    return {
      usage: parsed.usage as TokenUsage | undefined,
      overhead: parsed.overhead as TrialOverhead | undefined,
      status: parsed.status as AgentOutcome["status"] | undefined,
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  } catch {
    return {};
  }
}

export async function runDockerTrial(options: {
  readonly task: TaskSpec;
  readonly attempt: number;
  readonly bundle: HarnessBundle;
  readonly nodeDirs: Readonly<Record<LinuxArch, string>>;
  readonly model: string;
  readonly reasoning: string;
  readonly trialDir: string;
  readonly forwardEnv: Readonly<Record<string, string>>;
}): Promise<TrialResult> {
  const { task, attempt, bundle, nodeDirs, model, reasoning, trialDir, forwardEnv } = options;
  const startedAt = new Date().toISOString();
  const agentLogsLocal = join(trialDir, "agent");
  const verifierLogsLocal = join(trialDir, "verifier");
  await mkdir(trialDir, { recursive: true });

  let agentContainer: string | null = null;
  let verifierContainer: string | null = null;
  let builtImage: string | null = null;
  let agent: AgentOutcome = { status: "failed", exitCode: 1, durationMs: 0 };
  let verifier: VerifierOutcome = { status: "skipped", exitCode: 1, durationMs: 0 };
  let reward: number | null = null;
  let error: string | undefined;

  try {
    const resolved = await ensureTaskImage(task);
    if (resolved.builtLocally) builtImage = resolved.image;
    agentContainer = await startContainer(task, resolved.image, false);
    const [archOut, pwdOut] = await Promise.all([
      dockerCmd(["exec", agentContainer, "uname", "-m"], 15_000),
      dockerCmd(["exec", agentContainer, "pwd"], 15_000),
    ]);
    const arch: LinuxArch =
      archOut.stdout.trim() === "aarch64" || archOut.stdout.trim() === "arm64" ? "arm64" : "x64";
    const workdir = pwdOut.stdout.trim() || "/app";

    const prepRes = await execInContainer({
      container: agentContainer,
      command: `mkdir -p '${INSTALL_DIR}/arch' '${TASK_DIR}' '${LOGS_DIR}/agent' '${LOGS_DIR}/verifier' '${LOGS_DIR}/artifacts'`,
      timeoutMs: 30_000,
    });
    if (prepRes.exitCode !== 0) {
      throw new Error(`Failed to prepare directories inside container (exit ${prepRes.exitCode})`);
    }

    if (bundle.dir) await copyInto(`${bundle.dir}/.`, agentContainer, INSTALL_DIR);
    if (bundle.harness !== "eve-code") {
      await copyInto(PEER_RUNNER_SRC, agentContainer, `${INSTALL_DIR}/runner.mjs`);
    }
    const nodeDir = nodeDirs[arch];
    if (!nodeDir) throw new Error(`Missing Node runtime binary for container arch ${arch}`);
    await copyInto(`${nodeDir}/node`, agentContainer, `${INSTALL_DIR}/arch/node`);
    if (bundle.archDirs?.[arch]) {
      await copyInto(`${bundle.archDirs[arch]}/.`, agentContainer, `${INSTALL_DIR}/arch`);
    }
    await copyInto(task.instructionPath, agentContainer, `${TASK_DIR}/instruction.md`);

    const agentRes = await execInContainer({
      container: agentContainer,
      command: `exec '${INSTALL_DIR}/arch/node' '${INSTALL_DIR}/runner.mjs'`,
      env: {
        ...task.env,
        ...forwardEnv,
        CODE_BENCH_HARNESS: bundle.harness,
        CODE_BENCH_INSTALL_DIR: INSTALL_DIR,
        CODE_BENCH_INSTRUCTION: `${TASK_DIR}/instruction.md`,
        CODE_BENCH_LOGS_DIR: `${LOGS_DIR}/agent`,
        CODE_BENCH_TASK_WORKDIR: workdir,
        CODE_BENCH_MODEL: model,
        CODE_BENCH_REASONING: reasoning,
        CODE_BENCH_TIMEOUT_MS: String(task.agentTimeoutSec * 1000),
      },
      timeoutMs: (task.agentTimeoutSec + 30) * 1000,
      logPath: join(trialDir, "agent.log"),
    });
    agent = {
      status: agentRes.timedOut ? "timeout" : agentRes.exitCode === 0 ? "completed" : "failed",
      exitCode: agentRes.exitCode,
      durationMs: agentRes.durationMs,
    };

    for (const hook of task.collectHooks) {
      const hookRes = await execInContainer({
        container: agentContainer,
        command: hook.command,
        env: task.env,
        timeoutMs: hook.timeoutSec * 1000,
      });
      if (hookRes.exitCode !== 0 && !error) {
        error = `collect hook failed (exit ${hookRes.exitCode}): ${hook.command.slice(0, 120)}`;
      }
    }

    await copyFrom(agentContainer, `${LOGS_DIR}/agent`, agentLogsLocal);

    let verifyTarget = agentContainer;
    if (task.separateVerifier) {
      const localArtifacts = join(trialDir, "artifacts");
      const copiedArtifacts = await copyFrom(
        agentContainer,
        `${LOGS_DIR}/artifacts`,
        localArtifacts,
      );
      await dockerCmd(["rm", "-f", agentContainer], 30_000).catch(() => {});
      agentContainer = null;

      verifierContainer = await startContainer(task, resolved.image, true);
      verifyTarget = verifierContainer;
      const vPrep = await execInContainer({
        container: verifierContainer,
        command: `mkdir -p '${TESTS_DIR}' '${LOGS_DIR}/verifier' '${LOGS_DIR}/artifacts'`,
        timeoutMs: 30_000,
      });
      if (vPrep.exitCode !== 0) {
        throw new Error(`Failed to prepare verifier container (exit ${vPrep.exitCode})`);
      }
      if (copiedArtifacts) {
        await copyInto(`${localArtifacts}/.`, verifierContainer, `${LOGS_DIR}/artifacts`);
      }
    }

    await copyInto(`${task.testsDir}/.`, verifyTarget, TESTS_DIR);
    const verifyRes = await execInContainer({
      container: verifyTarget,
      command: `bash '${TESTS_DIR}/test.sh'`,
      env: task.env,
      timeoutMs: task.verifierTimeoutSec * 1000,
      logPath: join(trialDir, "verifier.log"),
    });
    verifier = {
      status: verifyRes.timedOut ? "timeout" : verifyRes.exitCode === 0 ? "completed" : "failed",
      exitCode: verifyRes.exitCode,
      durationMs: verifyRes.durationMs,
    };
    await copyFrom(verifyTarget, `${LOGS_DIR}/verifier`, verifierLogsLocal);

    const parsedReward = await readReward(verifierLogsLocal);
    reward = parsedReward.reward;
    if (parsedReward.error && !error) error = parsedReward.error;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    if (verifierContainer) await dockerCmd(["rm", "-f", verifierContainer], 30_000).catch(() => {});
    if (agentContainer) await dockerCmd(["rm", "-f", agentContainer], 30_000).catch(() => {});
    if (builtImage) await dockerCmd(["rmi", "-f", builtImage], 30_000).catch(() => {});
  }

  const telemetry = await readAgentTelemetry(agentLogsLocal);
  if (telemetry.status === "failed" && agent.status === "completed") {
    agent = { ...agent, status: "failed", exitCode: agent.exitCode || 1 };
  }
  if (!error && telemetry.error) error = telemetry.error;

  const result: TrialResult = {
    task: task.name,
    attempt,
    harness: bundle.harness,
    model,
    reward,
    agent,
    verifier,
    usage: telemetry.usage,
    overhead: telemetry.overhead,
    error,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  await writeFile(join(trialDir, "trial.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}
