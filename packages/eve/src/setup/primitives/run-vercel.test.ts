import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { captureVercel, runVercel, runVercelCaptureStdout } from "./run-vercel.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

const mockedSpawn = vi.mocked(spawn);

/**
 * The fake child covers only the surface run-vercel touches: stdout/stderr
 * streams, close/error events, and a spyable `kill`.
 */
type ChildProcessDouble = ChildProcess & {
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
};

function createChildProcess(): ChildProcessDouble {
  const child = new EventEmitter() as ChildProcessDouble;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
  return child;
}

/** Wires the fake child into the mocked `spawn`. */
function mockSpawnReturn(child: ChildProcessDouble): void {
  mockedSpawn.mockReturnValue(child as ReturnType<typeof spawn>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runVercel", () => {
  test("streams command output through a supplied handler", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);
    const onOutput = vi.fn();

    const result = runVercel(["deploy", "--prod"], {
      cwd: "/tmp/eve-agent",
      onOutput,
    });
    child.stdout.emit("data", Buffer.from("Production dep"));
    child.stdout.emit("data", Buffer.from("loyment ready\n"));
    child.stderr.emit("data", Buffer.from("Inspect: https://vercel.example/deployment\n"));
    child.emit("close", 0);

    await expect(result).resolves.toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "vercel",
      ["deploy", "--prod"],
      expect.objectContaining({ stdio: ["inherit", "pipe", "pipe"] }),
    );
    expect(onOutput.mock.calls.map(([line]) => line)).toEqual([
      { stream: "stdout", text: "Production deployment ready" },
      { stream: "stderr", text: "Inspect: https://vercel.example/deployment" },
    ]);
  });

  test("routes an exit diagnostic through the output handler after a failure", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);
    const onOutput = vi.fn();

    const result = runVercel(["deploy", "--prod"], {
      cwd: "/tmp/eve-agent",
      onOutput,
    });
    child.stderr.emit("data", Buffer.from("Build failed\n"));
    child.emit("close", 1);

    await expect(result).resolves.toBe(false);
    expect(onOutput.mock.calls.map(([line]) => line)).toEqual([
      { stream: "stderr", text: "Build failed" },
      { stream: "stderr", text: "vercel deploy --prod exited with code 1." },
    ]);
  });

  test("passes the CLI flag and closes stdin in non-interactive mode", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);

    const result = runVercel(["deploy", "--prod", "--yes"], {
      cwd: "/tmp/eve-agent",
      nonInteractive: true,
      onOutput: vi.fn(),
    });
    child.emit("close", 0);

    await expect(result).resolves.toBe(true);
    expect(mockedSpawn).toHaveBeenCalledWith(
      "vercel",
      ["deploy", "--prod", "--yes", "--non-interactive"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  test("passes cancellation to the child and settles without a stale failure line", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);
    const controller = new AbortController();
    const onOutput = vi.fn();

    const result = runVercel(["connect", "create", "slack"], {
      cwd: "/tmp/eve-agent",
      onOutput,
      signal: controller.signal,
    });
    expect(mockedSpawn).toHaveBeenCalledWith(
      "vercel",
      ["connect", "create", "slack"],
      expect.objectContaining({ signal: controller.signal }),
    );

    controller.abort();
    const error: NodeJS.ErrnoException = new Error("The operation was aborted");
    error.name = "AbortError";
    error.code = "ABORT_ERR";
    child.emit("error", error);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null);

    await expect(result).resolves.toBe(false);
    expect(onOutput).not.toHaveBeenCalled();
  });
});

describe("timeoutMs", () => {
  test("runVercelCaptureStdout settles as a failure and kills a stalled child", async () => {
    vi.useFakeTimers();
    try {
      const child = createChildProcess();
      mockSpawnReturn(child);
      const onOutput = vi.fn();

      const result = runVercelCaptureStdout(["connect", "create", "slack"], {
        cwd: "/tmp/eve-agent",
        onOutput,
        timeoutMs: 1_000,
      });
      // The child never exits: the OAuth hand-off was abandoned.
      vi.advanceTimersByTime(1_000);

      await expect(result).resolves.toEqual({ ok: false, stdout: "" });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(onOutput).toHaveBeenCalledWith({
        stream: "stderr",
        text: "vercel connect create slack timed out after 1s and was aborted.",
      });

      // A child that ignores SIGTERM gets SIGKILL after the grace period.
      vi.advanceTimersByTime(5_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      // A late kill-driven exit must not inject a second, stale diagnostic.
      child.emit("close", 1);
      expect(onOutput).not.toHaveBeenCalledWith({
        stream: "stderr",
        text: "vercel connect create slack exited with code 1.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("captureVercel reports the timeout as a failure diagnostic, not a success", async () => {
    vi.useFakeTimers();
    try {
      const child = createChildProcess();
      mockSpawnReturn(child);

      const result = captureVercel(["connect", "list", "-F", "json"], {
        cwd: "/tmp/eve-agent",
        timeoutMs: 1_000,
      });
      vi.advanceTimersByTime(1_000);
      // The signal-kill close (code null) must not flip the settled failure.
      child.emit("close", null);

      await expect(result).resolves.toEqual({
        ok: false,
        failure: {
          code: null,
          stdout: "",
          stderr: "",
          message: "vercel connect list -F json timed out after 1s and was aborted.",
        },
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    } finally {
      vi.useRealTimers();
    }
  });

  test("a clean exit before the deadline disarms the kill timer", async () => {
    vi.useFakeTimers();
    try {
      const child = createChildProcess();
      mockSpawnReturn(child);

      const result = runVercel(["connect", "detach", "slack/bot", "--yes"], {
        cwd: "/tmp/eve-agent",
        onOutput: vi.fn(),
        timeoutMs: 1_000,
      });
      child.emit("close", 0);
      vi.advanceTimersByTime(10_000);

      await expect(result).resolves.toBe(true);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("captureVercel", () => {
  test("resolves with stdout on a clean exit", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);

    const result = captureVercel(["whoami"], { cwd: "/tmp/eve-agent" });
    child.stdout.emit("data", Buffer.from("rconti\n"));
    child.emit("close", 0);

    await expect(result).resolves.toEqual({ ok: true, stdout: "rconti\n" });
  });

  test("spawns from the nearest existing ancestor when cwd does not exist yet", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);

    // The project parent does not exist until scaffold; account lookups must not
    // ENOENT on a missing cwd.
    const result = captureVercel(["whoami"], { cwd: "/tmp/eve-smoke-missing-xyz/my-agent" });
    child.stdout.emit("data", Buffer.from("rconti\n"));
    child.emit("close", 0);

    await expect(result).resolves.toEqual({ ok: true, stdout: "rconti\n" });
    const firstCall = mockedSpawn.mock.calls[0];
    expect(firstCall).toBeDefined();
    const spawnedCwd = (firstCall![2] as { cwd: string }).cwd;
    expect(spawnedCwd).not.toBe("/tmp/eve-smoke-missing-xyz/my-agent");
    expect(existsSync(spawnedCwd)).toBe(true);
  });

  test("preserves the failure diagnostic even with no output handler", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);

    const result = captureVercel(["whoami"], { cwd: "/tmp/eve-agent" });
    child.stderr.emit("data", Buffer.from("Error: not authorized\n"));
    child.emit("close", 1);

    await expect(result).resolves.toEqual({
      ok: false,
      failure: {
        code: 1,
        stdout: "",
        stderr: "Error: not authorized\n",
        message: "vercel whoami exited with code 1.",
      },
    });
    // stderr is always piped so the reason survives without a live renderer.
    expect(mockedSpawn).toHaveBeenCalledWith(
      "vercel",
      ["whoami"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  test("reports a missing CLI as a spawn error", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);

    const result = captureVercel(["whoami"], { cwd: "/tmp/eve-agent" });
    const error: NodeJS.ErrnoException = new Error("spawn vercel ENOENT");
    error.code = "ENOENT";
    child.emit("error", error);

    await expect(result).resolves.toEqual({
      ok: false,
      failure: {
        errno: "ENOENT",
        stdout: "",
        stderr: "",
        message: "Vercel CLI not found. Install with: npm i -g vercel@latest",
      },
    });
  });

  test("routes lookup stderr through the output handler when the lookup fails", async () => {
    const child = createChildProcess();
    mockSpawnReturn(child);
    const onOutput = vi.fn();

    const result = captureVercel(["connect", "list", "-F", "json"], {
      cwd: "/tmp/eve-agent",
      onOutput,
    });
    child.stderr.emit("data", Buffer.from("Connector lookup failed\n"));
    child.emit("close", 1);

    await expect(result).resolves.toEqual({
      ok: false,
      failure: {
        code: 1,
        stdout: "",
        stderr: "Connector lookup failed\n",
        message: "vercel connect list -F json exited with code 1.",
      },
    });
    expect(mockedSpawn).toHaveBeenCalledWith(
      "vercel",
      ["connect", "list", "-F", "json"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    expect(onOutput.mock.calls.map(([line]) => line)).toEqual([
      { stream: "stderr", text: "Connector lookup failed" },
      { stream: "stderr", text: "vercel connect list -F json exited with code 1." },
    ]);
  });
});
