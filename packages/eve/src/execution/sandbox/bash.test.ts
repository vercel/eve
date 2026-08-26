import { afterEach, describe, expect, it, vi } from "vitest";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxProcess, SandboxSession } from "#shared/sandbox-session.js";
import { MAX_OUTPUT_LINES } from "#execution/sandbox/truncate-output.js";

import {
  DEFAULT_BASH_YIELD_TIME_MS,
  executeBashOnSandbox,
  formatBashOutput,
  getBackgroundBashProcess,
  MAX_BACKGROUND_BASH_PROCESSES,
  startBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "./bash.js";

const previousDevFlag = process.env[EVE_DEV_ENV_FLAG];
let sandboxId = 0;

afterEach(() => {
  if (previousDevFlag === undefined) {
    delete process.env[EVE_DEV_ENV_FLAG];
  } else {
    process.env[EVE_DEV_ENV_FLAG] = previousDevFlag;
  }
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function outputStream(value: string, error?: unknown): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (error !== undefined) {
        controller.error(error);
        return;
      }
      if (value !== "") controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

function sandboxProcess(input?: {
  readonly exitCode?: number;
  readonly outputError?: unknown;
  readonly running?: boolean;
  readonly stderr?: string;
  readonly stdout?: string;
}): SandboxProcess {
  const completion = deferred<{ exitCode: number }>();
  if (input?.running !== true) completion.resolve({ exitCode: input?.exitCode ?? 0 });
  return {
    stderr: outputStream(input?.stderr ?? ""),
    stdout: outputStream(input?.stdout ?? "", input?.outputError),
    wait: vi.fn(() => completion.promise),
    kill: vi.fn(async () => completion.resolve({ exitCode: 143 })),
  };
}

function sandbox(createProcess: () => SandboxProcess = () => sandboxProcess()): SandboxSession {
  return {
    id: `sandbox-${sandboxId++}`,
    readBinaryFile: vi.fn(async () => null),
    readFile: vi.fn(async () => null),
    readTextFile: vi.fn(async () => null),
    removePath: vi.fn(async () => {}),
    resolvePath: (path) => path,
    run: vi.fn(async () => ({ exitCode: 0, stderr: "", stdout: "" })),
    setNetworkPolicy: vi.fn(async () => {}),
    spawn: vi.fn(async () => createProcess()),
    writeBinaryFile: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    writeTextFile: vi.fn(async () => {}),
  };
}

describe("executeBashOnSandbox", () => {
  it("returns completed output", async () => {
    const session = sandbox(() => sandboxProcess({ stdout: "done\n" }));

    await expect(executeBashOnSandbox(session, { command: "build" })).resolves.toEqual({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "done\n",
      truncated: false,
      wallTimeSeconds: expect.any(Number),
    });
  });

  it("yields a running command", async () => {
    const session = sandbox(() => sandboxProcess({ running: true, stdout: "partial" }));

    await expect(
      executeBashOnSandbox(session, { command: "build", yieldTimeMs: 0 }),
    ).resolves.toMatchObject({ status: "running" });
  });

  it("does not kill after an observation failure", async () => {
    const process = sandboxProcess({ outputError: new Error("read failed") });
    const session = sandbox(() => process);

    await expect(executeBashOnSandbox(session, { command: "build" })).rejects.toThrow(
      "read failed",
    );
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("kills when cancelled", async () => {
    const process = sandboxProcess({ running: true });
    const session = sandbox(() => process);
    const cancelled = new DOMException("cancelled", "AbortError");

    await expect(
      executeBashOnSandbox(
        session,
        { command: "build" },
        { abortSignal: AbortSignal.abort(cancelled) },
      ),
    ).rejects.toBe(cancelled);
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it("logs command progress in development", async () => {
    process.env[EVE_DEV_ENV_FLAG] = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const session = sandbox();

    await executeBashOnSandbox(session, { command: "pwd" });

    expect(log).toHaveBeenCalledWith("eve: starting sandbox command: pwd");
    expect(log).toHaveBeenCalledWith("eve: sandbox command finished (exit 0): pwd");
  });

  it("uses the default foreground wait", () => {
    expect(DEFAULT_BASH_YIELD_TIME_MS).toBe(300_000);
  });
});

describe("formatBashOutput", () => {
  it("preserves the end of long command output", () => {
    const lines = Array.from({ length: MAX_OUTPUT_LINES + 1 }, (_, index) => `line ${index}`);

    const result = formatBashOutput(lines.join("\n"), "", Date.now());

    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain("line 0\n");
    expect(result.stdout).toContain(`line ${MAX_OUTPUT_LINES}`);
  });
});

describe("background bash processes", () => {
  it("spawns the command through the sandbox process API", async () => {
    const session = sandbox();
    const process = await startBackgroundBashProcess(session, "exit 7");

    expect(process.processId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.spawn).toHaveBeenCalledWith({ command: "exit 7" });
    expect(session.run).not.toHaveBeenCalled();
  });

  it("reuses a command when the durable tool call is retried", async () => {
    const session = sandbox(() => sandboxProcess({ running: true }));

    const [first, retried] = await Promise.all([
      startBackgroundBashProcess(session, "sleep 10", "call-1"),
      startBackgroundBashProcess(session, "sleep 10", "call-1"),
    ]);

    expect(retried.processId).toBe(first.processId);
    expect(session.spawn).toHaveBeenCalledOnce();
  });

  it("rejects when the process cap is reached", async () => {
    const session = sandbox(() => sandboxProcess({ running: true }));
    await Promise.all(
      Array.from({ length: MAX_BACKGROUND_BASH_PROCESSES }, () =>
        startBackgroundBashProcess(session, "sleep 10"),
      ),
    );

    await expect(startBackgroundBashProcess(session, "sleep 10")).rejects.toThrow(
      `This sandbox already tracks ${MAX_BACKGROUND_BASH_PROCESSES} running commands.`,
    );
  });

  it("reads completed process state", async () => {
    const session = sandbox(() => sandboxProcess({ exitCode: 7, stderr: "err", stdout: "out" }));
    const started = await startBackgroundBashProcess(session, "build");
    await vi.waitFor(async () => {
      await expect(started.readStatus()).resolves.toEqual({ exitCode: 7 });
    });

    await expect(
      (await getBackgroundBashProcess(session, started.processId)).read(),
    ).resolves.toEqual({
      exitCode: 7,
      stderr: "err",
      stdout: "out",
      truncated: false,
    });
  });

  it("removes a killed process from the registry", async () => {
    const handle = sandboxProcess({ running: true });
    const session = sandbox(() => handle);
    const process = await startBackgroundBashProcess(session, "sleep 10");

    await process.kill();

    expect(handle.kill).toHaveBeenCalledOnce();
    await expect(getBackgroundBashProcess(session, process.processId)).rejects.toThrow(
      "unavailable",
    );
  });

  it("rejects unavailable process state", async () => {
    const session = sandbox();

    await expect(
      getBackgroundBashProcess(session, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toThrow("unavailable");
  });

  it("polls status without reading output", async () => {
    const read = vi.fn();
    const readStatus = vi.fn(async () => ({}));

    await expect(
      waitForBackgroundBashProcess({
        process: { kill: vi.fn(), processId: "process", read, readStatus },
        yieldTimeMs: 0,
      }),
    ).resolves.toBeNull();
    expect(readStatus).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });
});
