import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSandboxSession } from "#shared/sandbox-session.js";
import {
  getBackgroundBashProcess,
  waitForBackgroundBashProcess,
} from "#execution/sandbox/bash-background.js";

import { executeBashTool } from "./bash.js";

vi.mock("#execution/sandbox/bash-background.js", () => ({
  getBackgroundBashProcess: vi.fn(),
  startBackgroundBashProcess: vi.fn(),
  waitForBackgroundBashProcess: vi.fn(),
}));

const context = {
  abortSignal: new AbortController().signal,
  getSandbox: vi.fn(async () => ({}) as RuntimeSandboxSession),
};

function process(state: { exitCode?: number; stderr: string; stdout: string }) {
  return {
    kill: vi.fn(async () => {}),
    processId: "11111111-1111-4111-8111-111111111111",
    read: vi.fn(async () => state),
  };
}

describe("executeBashTool process actions", () => {
  afterEach(() => vi.resetAllMocks());

  it("polls a running process through bash", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockReturnValue(running);

    await expect(
      executeBashTool({ action: "poll", processId: running.processId }, context),
    ).resolves.toEqual({
      processId: running.processId,
      status: "running",
      stderr: "",
      stdout: "partial",
      truncated: false,
    });
  });

  it("waits for a process through bash", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockReturnValue(running);
    vi.mocked(waitForBackgroundBashProcess).mockResolvedValue({
      exitCode: 0,
      stderr: "",
      stdout: "done",
    });

    await expect(
      executeBashTool({ action: "wait", processId: running.processId, yieldAfter: 10 }, context),
    ).resolves.toEqual({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "done",
      truncated: false,
    });
  });

  it("kills a running process but preserves a completed result", async () => {
    const running = process({ stderr: "", stdout: "partial" });
    vi.mocked(getBackgroundBashProcess).mockReturnValueOnce(running);

    await expect(
      executeBashTool({ action: "kill", processId: running.processId }, context),
    ).resolves.toMatchObject({ status: "killed" });
    expect(running.kill).toHaveBeenCalledOnce();

    const completed = process({ exitCode: 7, stderr: "failed", stdout: "" });
    vi.mocked(getBackgroundBashProcess).mockReturnValueOnce(completed);
    await expect(
      executeBashTool({ action: "kill", processId: completed.processId }, context),
    ).resolves.toMatchObject({ exitCode: 7, status: "completed" });
    expect(completed.kill).not.toHaveBeenCalled();
  });
});
