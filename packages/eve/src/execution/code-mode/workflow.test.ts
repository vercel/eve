import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  initializeProgramStep: vi.fn(),
  runProgramStep: vi.fn(),
  approveProgramCallStep: vi.fn(),
  recordProgramCallStartedStep: vi.fn(),
  dispatchProgramCallStep: vi.fn(),
  ask: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("./program-step.js", () => mocks);
vi.mock("#execution/tools/workflow/ask.js", () => ({ askToApproveAction: mocks.ask }));
vi.mock("#compiled/@workflow/core/index.js", () => ({ sleep: mocks.sleep }));
import { executeProgramWorkflow } from "./workflow.js";
const ctx = { callId: "execute", abortSignal: new AbortController().signal } as never;
const input = { source: "return 1;", language: "js", context: {} } as never;
const first = {
  status: "parked",
  state: { token: "first" },
  calls: [
    { index: 0, tool: "read", input: {} },
    { index: 1, tool: "read", input: {} },
  ],
};

describe("code-mode durable driver", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.sleep.mockImplementation(() => new Promise(() => {}));
    mocks.initializeProgramStep.mockResolvedValue({
      limits: { deadlineAt: Date.now() + 300000 },
      toolNames: ["read", "write"],
    });
    mocks.approveProgramCallStep.mockResolvedValue({ status: "approved", key: "read", input: {} });
    mocks.recordProgramCallStartedStep.mockImplementation(async (callId) => ({
      callId,
      status: "started",
    }));
    mocks.dispatchProgramCallStep.mockImplementation(async (_ctx, _context, call) => ({
      index: call.index,
      status: "completed",
      output: call.index,
    }));
  });

  it("dispatches a parked batch concurrently, recording each start before dispatch", async () => {
    mocks.runProgramStep
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ status: "completed", output: [0, 1], logs: [] });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    mocks.dispatchProgramCallStep.mockImplementation(async (_ctx, _context, call) => {
      if (++started === 2) release();
      await pending;
      return { index: call.index, status: "completed", output: call.index };
    });
    expect(await executeProgramWorkflow(input, ctx)).toEqual({
      status: "completed",
      output: [0, 1],
      logs: [],
      interpreter: { startupMs: 0, runMs: 0 },
    });
    expect(started).toBe(2);
    for (let i = 0; i < 2; i++)
      expect(mocks.recordProgramCallStartedStep.mock.invocationCallOrder[i]).toBeLessThan(
        mocks.dispatchProgramCallStep.mock.invocationCallOrder[i]!,
      );
    expect(mocks.runProgramStep.mock.calls[1]![1]).toMatchObject({
      results: [
        { index: 0, status: "completed", output: 0 },
        { index: 1, status: "completed", output: 1 },
      ],
    });
  });

  it("sums interpreter timing across every parked start and resume", async () => {
    mocks.runProgramStep
      .mockResolvedValueOnce({ ...first, timing: { startupMs: 10, runMs: 3 } })
      .mockResolvedValueOnce({
        ...first,
        calls: [{ index: 2, tool: "write", input: {} }],
        timing: { startupMs: 0, runMs: 5 },
      })
      .mockResolvedValueOnce({
        status: "completed",
        output: "done",
        logs: [],
        timing: { startupMs: 2, runMs: 7 },
      });
    const output = await executeProgramWorkflow(input, ctx);
    expect(output).toEqual({
      status: "completed",
      output: "done",
      logs: [],
      interpreter: { startupMs: 12, runMs: 15 },
    });
  });

  it("includes zero interpreter timing on the early missing-context failure", async () => {
    expect(await executeProgramWorkflow({ source: "return 1;" }, ctx)).toEqual({
      status: "failed",
      errorClass: "runtime",
      error: "Code-mode execution context is missing.",
      logs: [],
      interpreter: { startupMs: 0, runMs: 0 },
    });
    expect(mocks.runProgramStep).not.toHaveBeenCalled();
  });

  it("reports timing and errorClass on immediate runtime failure", async () => {
    mocks.runProgramStep.mockResolvedValue({
      status: "failed",
      error: "bad syntax",
      errorClass: "syntax",
      logs: [],
      timing: { startupMs: 4, runMs: 6 },
    });
    expect(await executeProgramWorkflow(input, ctx)).toEqual({
      status: "failed",
      error: "bad syntax",
      errorClass: "syntax",
      logs: [],
      interpreter: { startupMs: 4, runMs: 6 },
    });
  });

  it("suspends for approval before starting the side effect", async () => {
    mocks.runProgramStep
      .mockResolvedValueOnce({ ...first, calls: [first.calls[0]] })
      .mockResolvedValueOnce({ status: "completed", output: 0, logs: [] });
    mocks.approveProgramCallStep.mockResolvedValue({ status: "required", key: "read", input: {} });
    mocks.ask.mockImplementation(async () => {
      expect(mocks.recordProgramCallStartedStep).not.toHaveBeenCalled();
      expect(mocks.dispatchProgramCallStep).not.toHaveBeenCalled();
      return { status: "answered", optionId: "approve" };
    });
    await executeProgramWorkflow(input, ctx);
    expect(mocks.ask).toHaveBeenCalledWith(ctx, expect.anything(), {
      kind: "tool-call",
      callId: "execute:program:0",
      toolName: "read",
      input: {},
    });
    expect(mocks.dispatchProgramCallStep).toHaveBeenCalledTimes(1);
  });

  it("passes unknown outcomes back without retrying dispatch", async () => {
    mocks.runProgramStep
      .mockResolvedValueOnce({ ...first, calls: [first.calls[0]] })
      .mockResolvedValueOnce({
        status: "failed",
        error: "unknown",
        errorClass: "runtime",
        logs: ["before"],
      });
    mocks.dispatchProgramCallStep.mockResolvedValue({
      index: 0,
      status: "unknown",
      error: "side effect may or may not have happened",
    });
    expect(await executeProgramWorkflow(input, ctx)).toMatchObject({
      status: "failed",
      logs: ["before"],
    });
    expect(mocks.dispatchProgramCallStep).toHaveBeenCalledTimes(1);
    expect(mocks.runProgramStep.mock.calls[1]![1]).toMatchObject({
      results: [{ index: 0, status: "unknown" }],
    });
  });

  it("terminates at the deadline while an approval is still pending", async () => {
    mocks.sleep.mockResolvedValue(undefined);
    mocks.ask.mockImplementation(() => new Promise(() => {}));
    mocks.approveProgramCallStep.mockResolvedValue({ status: "required", key: "read", input: {} });
    mocks.runProgramStep
      .mockResolvedValueOnce({
        ...first,
        calls: [first.calls[0]],
        timing: { startupMs: 9, runMs: 2 },
      })
      .mockResolvedValueOnce({
        status: "failed",
        error: "deadline",
        timing: { startupMs: 0, runMs: 3 },
        errorClass: "deadline",
        logs: ["last park"],
      });
    expect(await executeProgramWorkflow(input, ctx)).toMatchObject({
      status: "failed",
      errorClass: "deadline",
      logsMayBeTruncated: true,
      interpreter: { startupMs: 9, runMs: 5 },
    });
    expect(mocks.runProgramStep.mock.calls[1]![1]).toMatchObject({ state: first.state });
    expect(mocks.dispatchProgramCallStep).not.toHaveBeenCalled();
  });

  it("preserves failure logs and identifies truncation after interpreter termination", async () => {
    mocks.runProgramStep.mockResolvedValue({
      status: "failed",
      error: "timeout",
      errorClass: "deadline",
      logs: ["last park"],
    });
    expect(await executeProgramWorkflow(input, ctx)).toEqual({
      status: "failed",
      error: "timeout",
      errorClass: "deadline",
      logs: ["last park"],
      logsMayBeTruncated: true,
      interpreter: { startupMs: 0, runMs: 0 },
    });
  });
  it("does not dispatch after the deadline wins while approval policy is pending", async () => {
    let approve!: (x: unknown) => void;
    let expire!: () => void;
    mocks.sleep.mockImplementation(
      () =>
        new Promise<void>((r) => {
          expire = r;
        }),
    );
    mocks.approveProgramCallStep.mockImplementation(
      () =>
        new Promise((r) => {
          approve = r;
        }),
    );
    mocks.runProgramStep
      .mockResolvedValueOnce({ ...first, calls: [first.calls[0]] })
      .mockResolvedValueOnce({
        status: "failed",
        error: "deadline",
        errorClass: "deadline",
        logs: [],
      });
    const run = executeProgramWorkflow(input, ctx);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expire();
    expect(await run).toMatchObject({ status: "failed", errorClass: "deadline" });
    approve({ status: "approved", key: "read", input: {} });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(mocks.dispatchProgramCallStep).not.toHaveBeenCalled();
  });
});
