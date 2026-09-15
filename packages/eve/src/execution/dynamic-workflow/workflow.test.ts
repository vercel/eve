import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runWorkflowProgramStep: vi.fn(),
}));
vi.mock("#execution/dynamic-workflow/program-step.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runWorkflowProgramStep: mocks.runWorkflowProgramStep,
}));

import {
  MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  runJsProgram,
} from "#execution/dynamic-workflow/workflow.js";

const pending = {
  payload: {
    kind: "eve.workflow-program-agent-call",
    toolInput: { input: { message: "one" }, target: "researcher" },
    toolName: "agent",
  },
} as never;
const agent = vi.fn();
const ctx = {
  abortSignal: new AbortController().signal,
  agent,
  callId: "workflow-call",
} as never;
const options = { maxSubagents: 2 } as const;

describe("runJsProgram", () => {
  beforeEach(() => vi.resetAllMocks());

  it("delegates agent interrupts and resumes the sandbox", async () => {
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({ interrupt: pending, pending: [pending], status: "interrupted" })
      .mockResolvedValueOnce({ output: { result: "done" }, status: "completed" });
    agent.mockResolvedValue({ result: "child" });

    await expect(runJsProgram("return 1", ctx, options)).resolves.toEqual({ result: "done" });
    expect(agent).toHaveBeenCalledWith("researcher", { message: "one" });
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          interrupt: pending,
          resolutions: [{ status: "completed", output: { result: "child" } }],
        },
      }),
    );
  });

  it("keeps a pending batch in flight until every child settles", async () => {
    const secondPending = {
      payload: {
        kind: "eve.workflow-program-agent-call",
        toolInput: { input: { message: "two" }, target: "researcher" },
        toolName: "agent",
      },
    } as never;
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        interrupt: pending,
        pending: [pending, secondPending],
        status: "interrupted",
      })
      .mockResolvedValueOnce({ output: ["one", "two"], status: "completed" });
    agent.mockImplementation((_target, call: { readonly message: string }) =>
      call.message === "one" ? first.promise : second.promise,
    );

    const result = runJsProgram("return 1", ctx, options);
    await vi.waitFor(() => expect(agent).toHaveBeenCalledTimes(2));
    first.resolve("one");
    await Promise.resolve();
    expect(mocks.runWorkflowProgramStep).toHaveBeenCalledTimes(1);
    second.resolve("two");

    await expect(result).resolves.toEqual(["one", "two"]);
    expect(mocks.runWorkflowProgramStep).toHaveBeenCalledTimes(2);
  });

  it("returns catchable failures for failed children", async () => {
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({ interrupt: pending, pending: [pending], status: "interrupted" })
      .mockResolvedValueOnce({ output: "caught", status: "completed" });
    agent.mockRejectedValue(new Error("child failed"));

    await expect(runJsProgram("return 1", ctx, options)).resolves.toBe("caught");
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          interrupt: pending,
          resolutions: [{ status: "failed", error: "child failed" }],
        },
      }),
    );
  });

  it("bounds total calls across resumed batches", async () => {
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({ interrupt: pending, pending: [pending], status: "interrupted" })
      .mockResolvedValueOnce({
        interrupt: pending,
        pending: [pending, pending],
        status: "interrupted",
      })
      .mockResolvedValueOnce({ output: "limited", status: "completed" });
    agent.mockResolvedValueOnce("one").mockResolvedValueOnce("two");

    await expect(runJsProgram("return 1", ctx, options)).resolves.toBe("limited");
    expect(agent).toHaveBeenCalledTimes(2);
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          resolutions: [
            { status: "completed", output: "two" },
            expect.objectContaining({
              status: "failed",
              error: expect.stringContaining("WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED"),
            }),
          ],
        }),
      }),
    );
  });

  it("validates JavaScript and the trusted call budget before starting a program", async () => {
    await expect(runJsProgram(42 as never, ctx, options)).rejects.toThrow('requires a "js" string');
    await expect(
      runJsProgram("return 1", ctx, {
        maxSubagents: MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS + 1,
      }),
    ).rejects.toThrow("between 1 and 128");
    expect(mocks.runWorkflowProgramStep).not.toHaveBeenCalled();
  });

  it("keeps owner cancellation terminal", async () => {
    const controller = new AbortController();
    const cancelledCtx = {
      abortSignal: controller.signal,
      agent,
      callId: "workflow-call",
    } as never;
    mocks.runWorkflowProgramStep.mockResolvedValueOnce({
      interrupt: pending,
      pending: [pending],
      status: "interrupted",
    });
    agent.mockImplementation(async () => {
      controller.abort(new Error("owner cancelled"));
      throw new Error("child stopped");
    });

    await expect(runJsProgram("return 1", cancelledCtx, options)).rejects.toThrow(
      "owner cancelled",
    );
    expect(mocks.runWorkflowProgramStep).toHaveBeenCalledTimes(1);
  });
});
