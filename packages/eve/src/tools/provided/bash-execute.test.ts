import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import {
  executeBashOnSandbox,
  getBackgroundBashProcess,
  supportsDurableBashCompletion,
  waitForBackgroundBashProcess,
} from "#execution/sandbox/bash.js";
import {
  activateBashCompletionMonitor,
  closeBashCompletionMonitor,
  killBashCompletionMonitor,
  startBashCompletionMonitor,
} from "#execution/sandbox/bash-completion.js";

import { executeBashTool } from "./bash.js";

vi.mock("#execution/sandbox/bash.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/sandbox/bash.js")>()),
  executeBashOnSandbox: vi.fn(),
  getBackgroundBashProcess: vi.fn(),
  supportsDurableBashCompletion: vi.fn(() => false),
  waitForBackgroundBashProcess: vi.fn(),
}));

vi.mock("#execution/sandbox/bash-completion.js", () => ({
  activateBashCompletionMonitor: vi.fn(),
  closeBashCompletionMonitor: vi.fn(),
  killBashCompletionMonitor: vi.fn(),
  startBashCompletionMonitor: vi.fn(),
}));

const context = {
  abortSignal: new AbortController().signal,
  callId: "call-1",
  getSandbox: vi.fn(async () => ({}) as RuntimeSandboxSession),
  session: { id: "session-1" },
};

function process(state: {
  exitCode?: number;
  stderr: string;
  stdout: string;
  truncated?: boolean;
}) {
  const observation = { truncated: false, ...state };
  return {
    commandId: "11111111-1111-4111-8111-111111111111",
    inspect: vi.fn(async () => observation),
    inspectStatus: vi.fn(async () => ({ exitCode: state.exitCode })),
    terminate: vi.fn(async () => {}),
  };
}

describe("executeBashTool process actions", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.mocked(supportsDurableBashCompletion).mockReturnValue(false);
  });

  it("scopes start idempotency to the durable session", async () => {
    vi.mocked(executeBashOnSandbox).mockResolvedValue({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "",
      truncated: false,
      wallTimeSeconds: 0,
    });

    await executeBashTool({ action: "run", command: "true" }, context);

    expect(executeBashOnSandbox).toHaveBeenCalledWith(
      expect.anything(),
      { action: "run", command: "true" },
      {
        abortSignal: context.abortSignal,
        idempotencyKey: "session-1:call-1",
        onStarted: expect.any(Function),
      },
    );
  });

  it("polls a running process through bash", async () => {
    const running = process({ stderr: "", stdout: "partial", truncated: true });
    vi.mocked(getBackgroundBashProcess).mockResolvedValue(running);

    await expect(
      executeBashTool({ action: "poll", processId: running.commandId }, context),
    ).resolves.toEqual({
      processId: running.commandId,
      status: "running",
      stderr: "",
      stdout: "partial",
      truncated: true,
      wallTimeSeconds: expect.any(Number),
    });
  });

  it("activates a durable monitor only after the foreground call yields", async () => {
    const monitor = { controlToken: "control", processId: "process-1" };
    vi.mocked(startBashCompletionMonitor).mockResolvedValue(monitor);
    vi.mocked(executeBashOnSandbox).mockImplementation(async (_sandbox, _input, options) => {
      await options?.onStarted?.({ commandId: "process-1" } as never);
      expect(activateBashCompletionMonitor).not.toHaveBeenCalled();
      return {
        processId: "process-1",
        status: "running",
        stderr: "",
        stdout: "partial",
        truncated: false,
        wallTimeSeconds: 30,
      };
    });

    await executeBashTool({ action: "run", command: "sleep 60" }, context);

    expect(startBashCompletionMonitor).toHaveBeenCalledWith({
      processId: "process-1",
      sessionId: "session-1",
    });
    expect(activateBashCompletionMonitor).toHaveBeenCalledExactlyOnceWith(monitor);
    expect(closeBashCompletionMonitor).not.toHaveBeenCalled();
  });

  it("waits for a process through bash", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValue(running);
    vi.mocked(waitForBackgroundBashProcess).mockResolvedValue({ exitCode: 0 });
    running.inspect.mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "done",
      truncated: false,
    });

    await expect(
      executeBashTool({ action: "wait", processId: running.commandId }, context),
    ).resolves.toEqual({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "done",
      truncated: false,
      wallTimeSeconds: expect.any(Number),
    });
    expect(waitForBackgroundBashProcess).toHaveBeenCalledWith({
      abortSignal: context.abortSignal,
      process: running,
      yieldTimeMs: 30_000,
    });
  });

  it("inspects once without entering the wait loop when no inline time remains", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValue(running);

    await expect(
      executeBashTool({ action: "wait", processId: running.commandId, yieldTimeMs: 0 }, context),
    ).resolves.toMatchObject({ processId: running.commandId, status: "running" });

    expect(waitForBackgroundBashProcess).not.toHaveBeenCalled();
    expect(running.inspect).toHaveBeenCalledOnce();
  });

  it("kills a running process but preserves a completed result", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValueOnce(running);

    await expect(
      executeBashTool({ action: "kill", processId: running.commandId }, context),
    ).resolves.toMatchObject({ status: "killed" });
    expect(running.terminate).toHaveBeenCalledOnce();

    const completed = process({ exitCode: 7, stderr: "failed", stdout: "" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValueOnce(completed);
    await expect(
      executeBashTool({ action: "kill", processId: completed.commandId }, context),
    ).resolves.toMatchObject({ exitCode: 7, status: "completed" });
    expect(completed.terminate).not.toHaveBeenCalled();
  });

  it("returns an accepted monitor kill without terminating the process twice", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValue(running);
    vi.mocked(supportsDurableBashCompletion).mockReturnValue(true);
    vi.mocked(killBashCompletionMonitor).mockResolvedValue({
      observation: { stderr: "", stdout: "partial", truncated: false },
      status: "killed",
    });

    await expect(
      executeBashTool({ action: "kill", processId: running.commandId }, context),
    ).resolves.toMatchObject({ status: "killed", stdout: "partial" });

    expect(killBashCompletionMonitor).toHaveBeenCalledWith({
      processId: running.commandId,
      sessionId: "session-1",
      timeoutMs: 30_000,
    });
    expect(running.terminate).not.toHaveBeenCalled();
  });
});
