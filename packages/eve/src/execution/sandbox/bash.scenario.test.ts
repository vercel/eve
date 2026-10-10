import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

import { executeBashOnSandbox } from "./bash.js";
import { buildSandboxSession } from "./session.js";

const createScratchDirectory = useTemporaryDirectories();

// Real `bash -lc` on the host stands in for a sandbox; fake timers skip the 30-second yield.
describe("executeBashOnSandbox with a real shell", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a fast command's exit code and separate streams", async () => {
    const { sandbox } = await createHostSandbox();

    const result = await executeBashOnSandbox(sandbox, {
      command: "echo out; echo err >&2; exit 3",
    });

    expect(result).toEqual({
      exitCode: 3,
      status: "completed",
      stderr: "err\n",
      stdout: "out\n",
      truncated: false,
    });
  });

  it("leaves a slow command running, and kill stops its whole process group", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { home, launches, sandbox } = await createHostSandbox();
    await writeFile(join(home, ".bash_profile"), 'echo "Welcome to the sandbox"\n');
    const pidFile = join(home, "child.pid");

    const call = executeBashOnSandbox(sandbox, {
      command: `echo first; sleep 60 & echo $! > ${pidFile}; wait`,
    });
    const childPid = await readPid(pidFile);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await call;

    if (result.status !== "running") throw new Error(`expected running: ${JSON.stringify(result)}`);
    expect(result).toMatchObject({ stderr: "", stdout: "first\n", truncated: false });
    expect(result.message).toContain(`kill -- -${result.pid}`);
    // The call's stream ends at the yield; only the command keeps running.
    await launches[0];
    expect(isProcessAlive(childPid)).toBe(true);

    await runHostBash(`kill -- -${result.pid}`, home);

    await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false), { timeout: 10_000 });
    const exitFile = join(result.outputDirectory, "exit");
    await vi.waitFor(() => expect(readFileSync(exitFile, "utf8").trim()).toBe("143"), {
      timeout: 10_000,
    });
    await rm(result.outputDirectory, { force: true, recursive: true });
  });

  it("stops the command's process group when the call is aborted", async () => {
    const { home, sandbox } = await createHostSandbox();
    const pidFile = join(home, "child.pid");
    const controller = new AbortController();

    const call = executeBashOnSandbox(
      sandbox,
      { command: `sleep 60 & echo $! > ${pidFile}; wait` },
      { abortSignal: controller.signal },
    );
    const childPid = await readPid(pidFile);
    controller.abort();

    await expect(call).rejects.toThrow();
    await vi.waitFor(() => expect(isProcessAlive(childPid)).toBe(false), { timeout: 10_000 });
  });
});

async function createHostSandbox(): Promise<{
  readonly home: string;
  /** Settles when each launched process has exited and closed its output. */
  readonly launches: Promise<unknown>[];
  readonly sandbox: SandboxSession;
}> {
  const home = await createScratchDirectory("eve-bash-");
  const launches: Promise<unknown>[] = [];
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by the bash tool");
  };
  const sandbox = buildSandboxSession({
    readFile: unsupported,
    removePath: unsupported,
    resolvePath: (path) => path,
    writeFile: unsupported,
    async spawn(options) {
      const child = spawn("bash", ["-lc", options.command], {
        cwd: home,
        env: { ...process.env, HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = new Promise<{ exitCode: number }>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? 137 }));
      });
      launches.push(exited);
      // Like many providers, aborting kills only the launched process.
      options.abortSignal?.addEventListener("abort", () => child.kill("SIGKILL"), { once: true });
      return {
        pid: child.pid,
        stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
        stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        async wait() {
          const result = await exited;
          options.abortSignal?.throwIfAborted();
          return result;
        },
        async kill() {
          child.kill("SIGKILL");
        },
      };
    },
  });
  return { home, launches, sandbox };
}

async function runHostBash(command: string, home: string): Promise<void> {
  const child = spawn("bash", ["-c", command], { cwd: home, stdio: "ignore" });
  await new Promise((resolve) => child.on("close", resolve));
}

async function readPid(path: string): Promise<number> {
  await vi.waitFor(
    () => expect(existsSync(path) && readFileSync(path, "utf8").trim()).toMatch(/^\d+$/),
    { timeout: 10_000 },
  );
  return Number(readFileSync(path, "utf8"));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
