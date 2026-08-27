import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import { loadContext } from "#context/container.js";
import { serializeContext } from "#context/serialize.js";
import { supportsDurableBashCompletion } from "#execution/sandbox/bash.js";
import {
  activateBashCompletionMonitor,
  closeBashCompletionMonitor,
  killBashCompletionMonitor,
  startBashCompletionMonitor,
} from "#execution/sandbox/bash-completion.js";
import {
  bashCompletionWorkflowReference,
  startWorkflowPreferLatest,
  waitForCommandHookOwner,
} from "#execution/workflow-runtime.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";

vi.mock("#context/container.js", () => ({ loadContext: vi.fn() }));
vi.mock("#context/serialize.js", () => ({ serializeContext: vi.fn() }));
vi.mock("#execution/sandbox/bash.js", () => ({
  resolveBashInlineWaitMs: vi.fn((value: number) => value),
  supportsDurableBashCompletion: vi.fn(),
}));
vi.mock("#execution/workflow-runtime.js", () => ({
  bashCompletionWorkflowReference: { workflowId: "workflow//eve//bashCompletionWorkflow" },
  startWorkflowPreferLatest: vi.fn(),
  waitForCommandHookOwner: vi.fn(),
}));
vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: vi.fn(),
  resumeHook: vi.fn(),
}));

const sandbox = { id: "sandbox-1" };
const sandboxState = {
  initialized: true,
  session: {
    backendName: "vercel",
    metadata: { sandboxName: "sandbox-name" },
    sessionKey: "sandbox-1",
  },
};
const access = {
  captureState: vi.fn(async () => sandboxState),
  get: vi.fn(async () => sandbox),
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadContext).mockReturnValue({ require: () => access } as never);
  vi.mocked(serializeContext).mockReturnValue({ "eve.sessionId": "session-1" });
  vi.mocked(supportsDurableBashCompletion).mockReturnValue(true);
  vi.mocked(startWorkflowPreferLatest).mockResolvedValue({ runId: "monitor-run" } as never);
  vi.mocked(waitForCommandHookOwner).mockResolvedValue({ runId: "monitor-run" });
});

describe("Bash completion monitor controls", () => {
  it("starts one stable monitor after capturing reconnectable sandbox state", async () => {
    await expect(
      startBashCompletionMonitor({ processId: "process-1", sessionId: "session-1" }),
    ).resolves.toEqual({
      controlToken: "eve:bash-completion:session-1:process-1",
      processId: "process-1",
    });

    expect(startWorkflowPreferLatest).toHaveBeenCalledExactlyOnceWith(
      bashCompletionWorkflowReference,
      [
        {
          controlToken: "eve:bash-completion:session-1:process-1",
          deliveryId: "eve:bash-completion-delivery:session-1:process-1",
          processId: "process-1",
          sandboxState,
          serializedContext: { "eve.sessionId": "session-1" },
          sessionId: "session-1",
        },
      ],
    );
    expect(waitForCommandHookOwner).toHaveBeenCalledWith(
      "eve:bash-completion:session-1:process-1",
      { timeoutMs: 5_000 },
    );
  });

  it("does not start a durable monitor for a runtime-local backend", async () => {
    vi.mocked(supportsDurableBashCompletion).mockReturnValue(false);

    await expect(
      startBashCompletionMonitor({ processId: "process-1", sessionId: "session-1" }),
    ).resolves.toBeUndefined();

    expect(access.captureState).not.toHaveBeenCalled();
    expect(startWorkflowPreferLatest).not.toHaveBeenCalled();
  });

  it("sends activation and close through the monitor control hook", async () => {
    await activateBashCompletionMonitor({ controlToken: "control", processId: "process-1" });
    await closeBashCompletionMonitor({ controlToken: "control", processId: "process-1" });

    expect(resumeHook).toHaveBeenNthCalledWith(1, "control", { kind: "activate" });
    expect(resumeHook).toHaveBeenNthCalledWith(2, "control", { kind: "close" });
  });

  it("returns the monitor's serialized kill outcome", async () => {
    const outcome = {
      observation: { stderr: "", stdout: "partial", truncated: false },
      status: "killed" as const,
    };
    vi.mocked(resumeHook).mockResolvedValue({ runId: "monitor-run" } as never);
    vi.mocked(getRun).mockReturnValue({ returnValue: Promise.resolve(outcome) } as never);

    await expect(
      killBashCompletionMonitor({
        processId: "process-1",
        sessionId: "session-1",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual(outcome);
  });

  it("falls back to direct process control when no monitor owns the command", async () => {
    vi.mocked(resumeHook).mockRejectedValue(
      new HookNotFoundError("eve:bash-completion:session-1:process-1"),
    );

    await expect(
      killBashCompletionMonitor({
        processId: "process-1",
        sessionId: "session-1",
        timeoutMs: 1_000,
      }),
    ).resolves.toBeUndefined();
  });
});
