import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

import { createBashJobLaunch, type BashJobLaunchOutput } from "./bash-jobs.js";

const createScratchDirectory = useTemporaryDirectories();

type LaunchedJob = Extract<BashJobLaunchOutput, { kind: "job" }>;

// Runs the launcher the way sandbox providers run every command: `bash -lc`.
describe("bash job launcher", () => {
  it("returns a fast command's exit code and separate streams, then removes the job", async () => {
    const sandbox = await createHostSandbox();

    const result = await sandbox.launch("job-fast", "echo out; echo err >&2; exit 3");

    expect(result).toMatchObject({
      exitCode: 3,
      state: "exited",
      stderr: "err\n",
      stdout: "out\n",
    });
    expect(existsSync(join(sandbox.root, "jobs", "job-fast"))).toBe(false);
  });

  it("finds its report after output from the login shell's profile", async () => {
    const sandbox = await createHostSandbox();
    await writeFile(join(sandbox.home, ".bash_profile"), 'echo "Welcome to the sandbox"\n');

    const result = await sandbox.launch("job-profile", "exit 4");

    expect(result).toMatchObject({ exitCode: 4, jobId: "job-profile", state: "exited" });
  });

  it("leaves a slow command running and lets eve-job wait read only new output", async () => {
    const sandbox = await createHostSandbox();
    const started = await sandbox.launch("job-slow", "echo first; sleep 3; echo second", 2);
    expect(started).toMatchObject({ exitCode: undefined, state: "running", stdout: "first\n" });

    // Production keeps the longest wait under the yield; this test's yield is shorter.
    const waited = await sandbox.launch("job-observe", "eve-job wait job-slow 10", 15);

    expect(waited).toMatchObject({ exitCode: 0, state: "exited" });
    expect(waited.stdout).toBe("second\n[eve-job job-slow: exited with code 0]\n");
    expect(existsSync(join(sandbox.root, "jobs", "job-slow"))).toBe(false);
  });

  it("stops a running job's whole process group with eve-job stop", async () => {
    const sandbox = await createHostSandbox();
    const pidFile = join(sandbox.root, "child.pid");
    const started = await sandbox.launch("job-stoppable", `sleep 60 & echo $! > ${pidFile}; wait`);
    expect(started.state).toBe("running");
    const childPid = await readPid(pidFile);

    const stopped = await sandbox.launch("job-stopper", "eve-job stop job-stoppable");

    expect(stopped.stdout).toMatch(/\[eve-job job-stoppable: stopped \(exit code \d+\)\]\n$/);
    expect(isProcessAlive(childPid)).toBe(false);
  });

  it("stops the job when the launcher is killed before reporting it", async () => {
    const sandbox = await createHostSandbox();
    const pidFile = join(sandbox.root, "child.pid");
    const launch = createBashJobLaunch({
      command: `sleep 60 & echo $! > ${pidFile}; wait`,
      jobId: "job-cancelled",
      root: sandbox.root,
      yieldSeconds: 30,
    });
    const launcher = runLoginBash(launch.command, sandbox.home);
    const childPid = await readPid(pidFile);

    // Providers cancel a call by killing its process, often with SIGKILL.
    launcher.child.kill("SIGKILL");
    await launcher;

    await waitFor(() => !isProcessAlive(childPid));
    await waitFor(() => !existsSync(join(sandbox.root, "jobs", "job-cancelled")));
  });

  it("reattaches a retried call to the job its earlier attempt reported", async () => {
    const sandbox = await createHostSandbox();
    const runs = join(sandbox.root, "runs.log");
    const command = `echo run >> ${runs}; echo one; sleep 2; echo two; exit 7`;
    const first = await sandbox.launch("job-retried", command);
    expect(first.state).toBe("running");

    const retried = await sandbox.launch("job-retried", command, 10);

    expect(retried).toMatchObject({ exitCode: 7, jobId: "job-retried", stdout: "two\n" });
    expect(await readFile(runs, "utf8")).toBe("run\n");
  });

  it("runs a different command under a fresh id when its id is taken", async () => {
    const sandbox = await createHostSandbox();
    const first = await sandbox.launch("job-reused", "sleep 5");
    expect(first.state).toBe("running");

    const second = await sandbox.launch("job-reused", "echo second; exit 9");

    expect(second).toMatchObject({ exitCode: 9, state: "exited", stdout: "second\n" });
    expect(second.jobId).not.toBe("job-reused");
    await sandbox.launch("job-cleanup", "eve-job stop job-reused");
  });
});

interface HostSandbox {
  readonly home: string;
  readonly root: string;
  launch(jobId: string, command: string, yieldSeconds?: number): Promise<LaunchedJob>;
}

async function createHostSandbox(): Promise<HostSandbox> {
  const home = await createScratchDirectory("eve-bash-jobs-");
  const root = join(home, ".eve");
  return {
    home,
    root,
    async launch(jobId, command, yieldSeconds = 1) {
      const launch = createBashJobLaunch({ command, jobId, root, yieldSeconds });
      const output = await runLoginBash(launch.command, home);
      const parsed = launch.parse(output);
      if (parsed?.kind !== "job") {
        throw new Error(`launcher did not report a job: ${JSON.stringify(output)}`);
      }
      return parsed;
    },
  };
}

function runLoginBash(
  command: string,
  home: string,
): Promise<{ readonly stderr: string; readonly stdout: string }> & {
  readonly child: ChildProcess;
} {
  const child = spawn("bash", ["-lc", command], {
    cwd: home,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = new Promise<{ readonly stderr: string; readonly stdout: string }>(
    (resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", () => resolve({ stderr, stdout }));
    },
  );
  return Object.assign(output, { child });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met within 15s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readPid(path: string): Promise<number> {
  await waitFor(() => existsSync(path) && readFileSync(path, "utf8").trim().length > 0);
  return Number(await readFile(path, "utf8"));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
