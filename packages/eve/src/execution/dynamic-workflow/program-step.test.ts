import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RunConcurrencyError, RunCpuTimeoutError, RunError } from "#compiled/run/index.js";

const run = vi.fn();
vi.mock("#shared/workflow-sandbox.js", () => ({
  loadWorkflowSandboxModule: async () => ({
    RunError,
    createRunner: () => ({ run }),
    createSignedContinuationCodec: () => ({}),
    getHostFunctionContext: () => ({}),
  }),
}));

import { runWorkflowProgramStep } from "#execution/dynamic-workflow/program-step.js";

const step = () =>
  runWorkflowProgramStep({
    callId: "call",
    program: { continuationSecurity: { signingKey: "key" }, js: "return 1;", maxSubagents: 1 },
  });

describe("runWorkflowProgramStep failures", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => vi.useRealTimers());

  it("retries in-step on worker busy and succeeds when a worker frees up", async () => {
    vi.useFakeTimers();
    run
      .mockRejectedValueOnce(new RunConcurrencyError(4))
      .mockRejectedValueOnce(new RunConcurrencyError(4))
      .mockResolvedValueOnce({
        status: "completed",
        value: JSON.stringify({ logs: [], ok: true, value: 1 }),
      });

    const pending = step();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      logs: [],
      progress: [],
      result: 1,
      status: "completed",
    });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("returns EXECUTE_RUNTIME_BUSY after exhausting busy retries", async () => {
    vi.useFakeTimers();
    run.mockRejectedValue(new RunConcurrencyError(4));

    const pending = step();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      error: "EXECUTE_RUNTIME_BUSY: no program runtime was free. Run the program again.",
      logs: [],
      progress: [],
      status: "failed",
    });
    expect(run).toHaveBeenCalledTimes(7);
  });

  it.each([
    {
      error: new RunCpuTimeoutError(30_000),
      expected: "EXECUTE_CPU_LIMIT_REACHED",
      label: "CPU timeout",
    },
    {
      error: new RunError("wall timeout", "RUN_TIMEOUT"),
      expected: "EXECUTE_TIME_LIMIT_REACHED",
      label: "wall-clock timeout",
    },
    {
      error: new RunError("continuation too large", "RUN_CONTINUATION_TOO_LARGE"),
      expected: "EXECUTE_CONTINUATION_LIMIT_REACHED",
      label: "oversized continuation",
    },
  ])("maps $label RunError to a failed outcome with actionable guidance", async (row) => {
    run.mockRejectedValue(row.error);

    const outcome = await step();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toContain(row.expected);
    }
  });

  it("propagates unexpected host errors outside RunError", async () => {
    run.mockRejectedValue(new Error("host crash"));
    await expect(step()).rejects.toThrow("host crash");
  });
});
