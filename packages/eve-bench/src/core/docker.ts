import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Writable } from "node:stream";

const CAPTURE_LIMIT_BYTES = 16 * 1024 * 1024;
const LOG_LIMIT_BYTES = 64 * 1024 * 1024;
const LOG_TRUNCATED_LINE = "[eve-bench] log truncated at 64 MiB\n";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly log?: Writable;
}

export interface ContainerOptions {
  readonly image: string;
  readonly name: string;
  readonly job: string;
  readonly task: string;
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly network: boolean;
}

export interface RunnerContainer {
  readonly id: string;
  readonly name: string;
  readonly job: string;
  readonly task: string;
  readonly createdAt: string;
}

export class Container {
  readonly name: string;

  private constructor(name: string) {
    this.name = name;
  }

  static async start(options: ContainerOptions, signal?: AbortSignal): Promise<Container> {
    const args = [
      "run",
      "--detach",
      "--name",
      options.name,
      "--label",
      "eve-bench=1",
      "--label",
      `eve-bench.job=${options.job}`,
      "--label",
      `eve-bench.task=${options.task}`,
      "--entrypoint",
      "sh",
    ];
    if (options.cpus !== undefined) args.push("--cpus", String(options.cpus));
    if (options.memoryMb !== undefined) args.push("--memory", `${options.memoryMb}m`);
    if (!options.network) args.push("--network", "none");
    args.push(options.image, "-c", "sleep infinity");
    await dockerOk(args, { signal });
    return new Container(options.name);
  }

  /**
   * Runs `command` through `sh -c` inside the container. A `docker exec`
   * process is its own session and process-group leader, so recording its
   * pid lets timeouts and aborts kill the whole group in-container; killing
   * the host-side client alone would leave the workload running.
   */
  async exec(command: string, options: ExecOptions = {}): Promise<ProcessResult> {
    const pidFile = `/tmp/.eve-bench-${randomUUID()}.pid`;
    const wrapped = `echo $$ > ${pidFile}; exec sh -c "$0"`;
    const args = ["exec"];
    if (options.cwd) args.push("--workdir", options.cwd);
    for (const [key, value] of Object.entries(options.env ?? {}))
      args.push("--env", `${key}=${value}`);
    args.push(this.name, "sh", "-c", wrapped, command);
    const result = await docker(args, options);
    if (result.timedOut || result.aborted) {
      await docker(
        [
          "exec",
          this.name,
          "sh",
          "-c",
          `pid=$(cat ${pidFile} 2>/dev/null); [ -n "$pid" ] && { kill -KILL -- -$pid 2>/dev/null; kill -KILL $pid 2>/dev/null; }; true`,
        ],
        { timeoutMs: 10_000 },
      );
    }
    return result;
  }

  async upload(hostPath: string, containerPath: string, signal?: AbortSignal): Promise<void> {
    await dockerOk(["cp", hostPath, `${this.name}:${containerPath}`], { signal });
  }

  async download(containerPath: string, hostPath: string, signal?: AbortSignal): Promise<boolean> {
    const result = await docker(["cp", `${this.name}:${containerPath}`, hostPath], { signal });
    return result.exitCode === 0;
  }

  async remove(): Promise<void> {
    await docker(["rm", "--force", "--volumes", this.name], { timeoutMs: 60_000 });
  }
}

export async function assertDockerAvailable(): Promise<void> {
  try {
    await dockerOk(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
  } catch {
    throw new Error("Docker is unavailable; start the Docker daemon and retry.");
  }
}

export async function listRunnerContainers(
  filter: {
    job?: string;
  } = {},
): Promise<RunnerContainer[]> {
  const args = [
    "ps",
    "-a",
    "--filter",
    "label=eve-bench=1",
    ...(filter.job ? ["--filter", `label=eve-bench.job=${filter.job}`] : []),
    "--format",
    "{{json .}}",
  ];
  const result = await dockerOk(args, { timeoutMs: 30_000 });
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as Record<string, string>;
      return {
        id: row.ID ?? "",
        name: row.Names ?? "",
        job: labelValue(row.Labels, "eve-bench.job"),
        task: labelValue(row.Labels, "eve-bench.task"),
        createdAt: row.CreatedAt ?? "",
      };
    });
}

export async function removeRunnerContainers(
  filter: {
    job?: string;
  } = {},
): Promise<RunnerContainer[]> {
  const containers = await listRunnerContainers(filter);
  if (containers.length > 0) {
    await dockerOk(["rm", "--force", "--volumes", ...containers.map((container) => container.id)], {
      timeoutMs: 60_000,
    });
  }
  return containers;
}

export function createBoundedLog(path: string): Writable {
  return createBoundedWritable(createWriteStream(path), LOG_LIMIT_BYTES);
}

export function createBoundedWritable(output: Writable, limitBytes: number): Writable {
  let written = 0;
  let truncated = false;
  return new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
      const remaining = Math.max(0, limitBytes - written);
      const kept = bytes.subarray(0, remaining);
      written += kept.length;
      if (kept.length < bytes.length) truncated = true;
      if (kept.length === 0) callback();
      else output.write(kept, callback);
    },
    final(callback) {
      output.end(truncated ? LOG_TRUNCATED_LINE : undefined, callback);
    },
  });
}

export async function imageExists(tag: string): Promise<boolean> {
  const result = await docker(["image", "inspect", tag], { timeoutMs: 30_000 });
  return result.exitCode === 0;
}

export async function pullImage(image: string, options: ExecOptions = {}): Promise<void> {
  if (await imageExists(image)) return;
  await dockerOk(["pull", image], options);
}

export async function buildImage(
  tag: string,
  contextDir: string,
  options: ExecOptions = {},
): Promise<void> {
  if (await imageExists(tag)) return;
  await dockerOk(["build", "--tag", tag, contextDir], options);
}

export async function containerArch(container: Container): Promise<"x64" | "arm64"> {
  const result = await container.exec("uname -m", { timeoutMs: 10_000 });
  const machine = result.stdout.trim();
  if (machine === "x86_64") return "x64";
  if (machine === "aarch64") return "arm64";
  throw new Error(`Unsupported container architecture: ${machine || result.stderr.trim()}`);
}

async function dockerOk(args: readonly string[], options: ExecOptions): Promise<ProcessResult> {
  const result = await docker(args, options);
  if (result.exitCode !== 0) {
    const reason = result.timedOut
      ? "timed out"
      : result.aborted
        ? "aborted"
        : `exit ${result.exitCode}`;
    throw new Error(`docker ${args[0]} ${reason}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function docker(args: readonly string[], options: ExecOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendHead(stdout, stdoutBytes, chunk, CAPTURE_LIMIT_BYTES);
      options.log?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendHead(stderr, stderrBytes, chunk, CAPTURE_LIMIT_BYTES);
      options.log?.write(chunk);
    });
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolve({
        exitCode: code,
        timedOut,
        aborted,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    function cleanup() {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}

function appendHead(chunks: Buffer[], size: number, chunk: Buffer, limit: number): number {
  const kept = chunk.subarray(0, Math.max(0, limit - size));
  if (kept.length > 0) chunks.push(kept);
  return size + kept.length;
}

function labelValue(labels: string | undefined, key: string): string {
  const prefix = `${key}=`;
  return (
    labels
      ?.split(",")
      .find((label) => label.startsWith(prefix))
      ?.slice(prefix.length) ?? ""
  );
}
