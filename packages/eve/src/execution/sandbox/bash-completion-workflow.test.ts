import { afterEach, describe, expect, it, vi } from "vitest";
import { createHook, sleep, type Hook } from "#compiled/@workflow/core/index.js";

import type {
  BashCompletionControl,
  BashCompletionMonitorInput,
} from "#execution/sandbox/bash-completion-contract.js";
import {
  deliverBashCompletionStep,
  inspectBashCommandStep,
  killBashCommandStep,
} from "#execution/sandbox/bash-completion-steps.js";
import { bashCompletionWorkflow } from "#execution/sandbox/bash-completion-workflow.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
  sleep: vi.fn(),
}));

vi.mock("#execution/hook-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/hook-ownership.js")>()),
  claimHookOwnership: vi.fn(),
  disposeHook: vi.fn(),
}));

vi.mock("#execution/sandbox/bash-completion-steps.js", () => ({
  deliverBashCompletionStep: vi.fn(),
  inspectBashCommandStep: vi.fn(),
  killBashCommandStep: vi.fn(),
}));

const input: BashCompletionMonitorInput = {
  controlToken: "control",
  deliveryId: "delivery",
  processId: "process-1",
  sandboxState: {
    initialized: true,
    session: { backendName: "vercel", metadata: {}, sessionKey: "sandbox-1" },
  },
  serializedContext: {},
  sessionId: "session-1",
};

afterEach(() => {
  vi.resetAllMocks();
  vi.mocked(sleep).mockImplementation(() => new Promise<void>(() => {}));
});

function mockControlHook(payloads: readonly BashCompletionControl[]): void {
  const queue = [...payloads];
  const hook = {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        queue.length === 0
          ? new Promise<IteratorResult<BashCompletionControl>>(() => {})
          : Promise.resolve({ done: false as const, value: queue.shift()! }),
    }),
    token: input.controlToken,
  } as Hook<BashCompletionControl>;
  vi.mocked(createHook).mockReturnValue(hook);
}

describe("bashCompletionWorkflow", () => {
  it("delivers one queued completion after activation", async () => {
    mockControlHook([{ kind: "activate" }]);
    vi.mocked(sleep).mockImplementation(async (duration) => {
      if (duration === 1_000) return;
      return await new Promise<void>(() => {});
    });
    const observation = {
      exitCode: 0,
      stderr: "",
      stdout: "done",
      truncated: false,
    };
    vi.mocked(inspectBashCommandStep).mockResolvedValue(observation);

    await expect(bashCompletionWorkflow(input)).resolves.toEqual({
      observation,
      status: "completed",
    });

    expect(deliverBashCompletionStep).toHaveBeenCalledExactlyOnceWith({
      ...input,
      observation,
    });
    expect(killBashCommandStep).not.toHaveBeenCalled();
    expect(disposeHook).toHaveBeenCalledOnce();
  });

  it("lets an accepted kill win without delivering completion", async () => {
    mockControlHook([{ kind: "activate" }, { kind: "kill" }]);
    const killed = {
      observation: { stderr: "", stdout: "partial", truncated: false },
      status: "killed" as const,
    };
    vi.mocked(killBashCommandStep).mockResolvedValue(killed);

    await expect(bashCompletionWorkflow(input)).resolves.toEqual(killed);

    expect(inspectBashCommandStep).not.toHaveBeenCalled();
    expect(deliverBashCompletionStep).not.toHaveBeenCalled();
  });

  it("closes without observing the command when the foreground call completed", async () => {
    mockControlHook([{ kind: "close" }]);

    await expect(bashCompletionWorkflow(input)).resolves.toEqual({ status: "closed" });

    expect(inspectBashCommandStep).not.toHaveBeenCalled();
    expect(deliverBashCompletionStep).not.toHaveBeenCalled();
  });

  it("leaves duplicate monitor ownership with the first workflow", async () => {
    mockControlHook([]);
    vi.mocked(claimHookOwnership).mockRejectedValue(
      Object.assign(new Error("owned"), { name: "HookConflictError" }),
    );

    await expect(bashCompletionWorkflow(input)).resolves.toEqual({ status: "closed" });

    expect(inspectBashCommandStep).not.toHaveBeenCalled();
    expect(deliverBashCompletionStep).not.toHaveBeenCalled();
    expect(disposeHook).not.toHaveBeenCalled();
  });
});
