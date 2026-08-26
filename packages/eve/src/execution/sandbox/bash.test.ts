import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "#shared/sandbox-session.js";
import {
  startBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "#execution/sandbox/bash-background.js";

import { DEFAULT_BASH_YIELD_TIME_MS, executeBashOnSandbox } from "./bash.js";

vi.mock("#execution/sandbox/bash-background.js", () => ({
  startBackgroundBashProcess: vi.fn(),
  waitForBackgroundBashProcess: vi.fn(),
}));

const sandbox = {} as SandboxSession;

function process() {
  return {
    kill: vi.fn(async () => {}),
    processId: "process-123",
    read: vi.fn(async () => ({ stderr: "partial err", stdout: "partial out" })),
  };
}

describe("executeBashOnSandbox", () => {
  afterEach(() => vi.resetAllMocks());

  it("returns completed output when the command finishes during the foreground wait", async () => {
    const running = process();
    vi.mocked(startBackgroundBashProcess).mockResolvedValue(running);
    vi.mocked(waitForBackgroundBashProcess).mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "done\n",
    });

    await expect(executeBashOnSandbox(sandbox, { command: "build" })).resolves.toEqual({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "done\n",
      truncated: false,
      wallTimeSeconds: expect.any(Number),
    });
    expect(waitForBackgroundBashProcess).toHaveBeenCalledWith({
      abortSignal: undefined,
      process: running,
      yieldTimeMs: DEFAULT_BASH_YIELD_TIME_MS,
    });
  });

  it("returns a process receipt instead of killing a command after yieldTimeMs", async () => {
    const running = process();
    vi.mocked(startBackgroundBashProcess).mockResolvedValue(running);
    vi.mocked(waitForBackgroundBashProcess).mockResolvedValue(null);

    await expect(
      executeBashOnSandbox(sandbox, { command: "build", yieldTimeMs: 10_000 }),
    ).resolves.toEqual({
      processId: "process-123",
      status: "running",
      stderr: "partial err",
      stdout: "partial out",
      truncated: false,
      wallTimeSeconds: expect.any(Number),
    });
    expect(waitForBackgroundBashProcess).toHaveBeenCalledWith({
      abortSignal: undefined,
      process: running,
      yieldTimeMs: 10_000,
    });
    expect(running.kill).not.toHaveBeenCalled();
  });

  it("kills a background command when the turn is cancelled", async () => {
    const running = process();
    const cancelled = new DOMException("cancelled", "AbortError");
    vi.mocked(startBackgroundBashProcess).mockResolvedValue(running);
    vi.mocked(waitForBackgroundBashProcess).mockRejectedValue(cancelled);

    await expect(
      executeBashOnSandbox(
        sandbox,
        { command: "build" },
        { abortSignal: AbortSignal.abort(cancelled) },
      ),
    ).rejects.toBe(cancelled);
    expect(running.kill).toHaveBeenCalledOnce();
  });
});
