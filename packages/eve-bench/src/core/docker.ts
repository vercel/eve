import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

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
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly network: boolean;
}

export class Container {
  readonly name: string;

  private constructor(name: string) {
    this.name = name;
  }

  static async start(options: ContainerOptions, signal?: AbortSignal): Promise<Container> {
    const args = ["run", "--detach", "--name", options.name, "--entrypoint", "sh"];
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
      stdout.push(chunk);
      options.log?.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
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
