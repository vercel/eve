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

const pending = { call: { input: { message: "one" }, target: "researcher" }, id: "interrupt-1" };
const secondPending = {
  call: { input: { message: "two" }, target: "researcher" },
  id: "interrupt-2",
};
const continuation = "signed-continuation";
/** Each child's reply to the one message a program sends it. */
const reply = vi.fn();
const agent = (target: string) => ({
  send: async (message: string) => ({
    result: async () => ({
      data: undefined,
      message: await reply(target, message),
      status: "waiting",
    }),
  }),
});
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
      .mockResolvedValueOnce({ continuation, pending: [pending], status: "interrupted" })
      .mockResolvedValueOnce({ output: { result: "done" }, status: "completed" });
    reply.mockResolvedValue({ result: "child" });

    await expect(runJsProgram("return 1", ctx, options)).resolves.toEqual({ result: "done" });
    expect(reply).toHaveBeenCalledWith("researcher", "one");
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          continuation,
          resolutions: [
            {
              interruptionId: "interrupt-1",
              value: { status: "completed", output: { result: "child" } },
            },
          ],
        },
      }),
    );
  });

  it("keeps a pending batch in flight until every child settles", async () => {
    const first = Promise.withResolvers<unknown>();
    const second = Promise.withResolvers<unknown>();
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        continuation,
        pending: [pending, secondPending],
        status: "interrupted",
      })
      .mockResolvedValueOnce({ output: ["one", "two"], status: "completed" });
    reply.mockImplementation((_target, message: string) =>
      message === "one" ? first.promise : second.promise,
    );

    const result = runJsProgram("return 1", ctx, options);
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    first.resolve("one");
    await Promise.resolve();
    expect(mocks.runWorkflowProgramStep).toHaveBeenCalledTimes(1);
    second.resolve("two");

    await expect(result).resolves.toEqual(["one", "two"]);
    expect(mocks.runWorkflowProgramStep).toHaveBeenCalledTimes(2);
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          continuation,
          resolutions: [
            { interruptionId: "interrupt-1", value: { status: "completed", output: "one" } },
            { interruptionId: "interrupt-2", value: { status: "completed", output: "two" } },
          ],
        },
      }),
    );
  });

  it("returns catchable failures for failed children", async () => {
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({ continuation, pending: [pending], status: "interrupted" })
      .mockResolvedValueOnce({ output: "caught", status: "completed" });
    reply.mockRejectedValue(new Error("child failed"));

    await expect(runJsProgram("return 1", ctx, options)).resolves.toBe("caught");
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          continuation,
          resolutions: [
            { interruptionId: "interrupt-1", value: { status: "failed", error: "child failed" } },
          ],
        },
      }),
    );
  });

  it("bounds total calls across resumed batches", async () => {
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({ continuation, pending: [pending], status: "interrupted" })
      .mockResolvedValueOnce({
        continuation,
        pending: [pending, secondPending],
        status: "interrupted",
      })
      .mockResolvedValueOnce({ output: "limited", status: "completed" });
    reply.mockResolvedValueOnce("one").mockResolvedValueOnce("two");

    await expect(runJsProgram("return 1", ctx, options)).resolves.toBe("limited");
    expect(reply).toHaveBeenCalledTimes(2);
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          resolutions: [
            { interruptionId: "interrupt-1", value: { status: "completed", output: "two" } },
            {
              interruptionId: "interrupt-2",
              value: {
                status: "failed",
                error: expect.stringContaining("WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED"),
              },
            },
          ],
        }),
      }),
    );
  });

  it("returns a catchable failure for a child reply over 4 MiB of JSON", async () => {
    // Quotes make each JSON text 4 MiB and 4 MiB + 1 byte.
    const atLimit = "<".repeat(4 * 1024 * 1024 - 2);
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        continuation,
        pending: [pending, secondPending],
        status: "interrupted",
      })
      .mockResolvedValueOnce({ output: "caught", status: "completed" });
    reply.mockImplementation((_target, message: string) =>
      message === "one" ? atLimit : `${atLimit}<`,
    );

    await expect(runJsProgram("return 1", ctx, options)).resolves.toBe("caught");
    const { resolutions } = mocks.runWorkflowProgramStep.mock.lastCall![0].resume;
    expect(resolutions[0]).toEqual({
      interruptionId: "interrupt-1",
      value: { status: "completed", output: atLimit },
    });
    expect(resolutions[1]).toEqual({
      interruptionId: "interrupt-2",
      value: {
        status: "failed",
        error:
          'Agent "researcher" replied with 4194305 bytes of JSON, over the 4194304 byte limit for a ctx.agent() result.',
      },
    });
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
      continuation,
      pending: [pending],
      status: "interrupted",
    });
    reply.mockImplementation(async () => {
      controller.abort(new Error("owner cancelled"));
      throw new Error("child stopped");
    });

    await expect(runJsProgram("return 1", cancelledCtx, options)).rejects.toThrow(
      "owner cancelled",
    );
    expect(mocks.runWorkflowProgramStep).toHaveBeenCalledTimes(1);
  });
});
