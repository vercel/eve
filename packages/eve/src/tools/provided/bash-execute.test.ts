import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import {
  executeBashOnSandbox,
  getBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "#execution/sandbox/bash.js";

import { executeBashTool } from "./bash.js";

vi.mock("#execution/sandbox/bash.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/sandbox/bash.js")>()),
  executeBashOnSandbox: vi.fn(),
  getBackgroundBashProcess: vi.fn(),
  waitForBackgroundBashProcess: vi.fn(),
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
  return {
    kill: vi.fn(async () => {}),
    processId: "11111111-1111-4111-8111-111111111111",
    read: vi.fn(async () => state),
    readStatus: vi.fn(async () => ({ exitCode: state.exitCode })),
  };
}

describe("executeBashTool process actions", () => {
  afterEach(() => vi.resetAllMocks());

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
      },
    );
  });

  it("polls a running process through bash", async () => {
    const running = process({ stderr: "", stdout: "partial", truncated: true });
    vi.mocked(getBackgroundBashProcess).mockResolvedValue(running);

    await expect(
      executeBashTool({ action: "poll", processId: running.processId }, context),
    ).resolves.toEqual({
      processId: running.processId,
      status: "running",
      stderr: "",
      stdout: "partial",
      truncated: true,
      wallTimeSeconds: expect.any(Number),
    });
  });

  it("waits for a process through bash", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValue(running);
    vi.mocked(waitForBackgroundBashProcess).mockResolvedValue({ exitCode: 0 });
    running.read.mockResolvedValue({ exitCode: 0, stderr: "", stdout: "done" });

    await expect(
      executeBashTool(
        { action: "wait", processId: running.processId, yieldTimeMs: 10_000 },
        context,
      ),
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
      yieldTimeMs: 10_000,
    });
  });

  it("kills a running process but preserves a completed result", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValueOnce(running);

    await expect(
      executeBashTool({ action: "kill", processId: running.processId }, context),
    ).resolves.toMatchObject({ status: "killed" });
    expect(running.kill).toHaveBeenCalledOnce();

    const completed = process({ exitCode: 7, stderr: "failed", stdout: "" });
    vi.mocked(getBackgroundBashProcess).mockResolvedValueOnce(completed);
    await expect(
      executeBashTool({ action: "kill", processId: completed.processId }, context),
    ).resolves.toMatchObject({ exitCode: 7, status: "completed" });
    expect(completed.kill).not.toHaveBeenCalled();
  });
});
