import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryResult } from "#shared/delivery.js";
import type { MessageContent } from "#shared/message-content.js";

const mocks = vi.hoisted(() => ({
  runWorkflowProgramStep: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("#execution/dynamic-workflow/program-step.js", async (importOriginal) => ({
  ...(await importOriginal()),
  runWorkflowProgramStep: mocks.runWorkflowProgramStep,
}));
vi.mock("#compiled/@workflow/core/index.js", async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: mocks.sleep,
}));

import {
  MAX_WORKFLOW_PROGRAM_MAX_SUBAGENTS,
  runJsProgram,
} from "#execution/dynamic-workflow/workflow.js";
import { WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS } from "#execution/dynamic-workflow/schema.js";
import { attachWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";

const pending = {
  action: { input: { message: "one" }, kind: "agent" as const, target: "researcher" },
  id: "interrupt-1",
};
const secondPending = {
  action: { input: { message: "two" }, kind: "agent" as const, target: "researcher" },
  id: "interrupt-2",
};
const continuation = "signed-continuation";
const reply = vi.fn();
const agent = vi.fn((target: string) => ({
  send: async (message: MessageContent<string | URL>) => ({
    result: async (): Promise<DeliveryResult> => {
      const output: unknown = await reply(target, message);
      return {
        sessionId: "child",
        deliveryId: "child-request",
        outcome: "handled",
        sessionEnded: false,
        data: typeof output === "string" ? undefined : output,
        reply: typeof output === "string" ? output : undefined,
        interactions: [],
        status: "completed",
      };
    },
  }),
}));
const ask = vi.fn();
const ctx = {
  abortSignal: new AbortController().signal,
  agent,
  agents: { researcher: { description: "Researches topics" } },
  ask,
  callId: "workflow-call",
} as never;
const options = { maxSubagents: 2 } as const;

describe("runJsProgram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("snapshots ctx.agents, passes files to ctx.agent, and returns raw result when logs are empty", async () => {
    const rich = {
      action: {
        input: {
          files: [
            {
              filename: "brief.pdf",
              mediaType: "application/pdf",
              url: "https://files.example/brief.pdf",
            },
          ],
          message: "review this",
          outputSchema: { type: "object" },
        },
        kind: "agent" as const,
        target: "researcher",
      },
      id: "interrupt-1",
    };
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        continuation,
        pending: [rich],
        progress: [],
        status: "interrupted",
      })
      .mockResolvedValueOnce({
        logs: [],
        progress: [],
        result: { result: "done" },
        status: "completed",
      });
    reply.mockResolvedValue({ result: "child" });

    await expect(runJsProgram("return 1", ctx, options)).resolves.toEqual({ result: "done" });
    const firstStepCall = mocks.runWorkflowProgramStep.mock.calls[0]![0];
    expect(firstStepCall.program.agents).toEqual({
      researcher: { description: "Researches topics" },
    });
    expect(firstStepCall.program.continuationSecurity.maxAgeMs).toBeGreaterThan(
      WORKFLOW_PROGRAM_MAX_SLEEP_SECONDS * 1_000,
    );
    expect(agent).toHaveBeenCalledWith("researcher");
    expect(reply).toHaveBeenCalledWith("researcher", [
      { text: "review this", type: "text" },
      {
        data: "https://files.example/brief.pdf",
        filename: "brief.pdf",
        mediaType: "application/pdf",
        type: "file",
      },
    ]);
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

  it("dispatches ctx.ask, ctx.sleep, and ctx.progress and wraps non-empty console logs", async () => {
    const events: string[] = [];
    const ownerSend = vi.fn(
      async (message: { readonly kind: string; readonly update?: unknown }) => {
        events.push(`report:${JSON.stringify(message.update)}`);
      },
    );
    const hostSleep = vi.fn(async (ms: number) => {
      events.push(`sleep:${String(ms)}`);
    });
    const controller = new AbortController();
    const runCtx = {
      abortSignal: controller.signal,
      agent,
      agents: {},
      ask: vi.fn(async (request: unknown) => {
        events.push(`ask:${(request as { readonly prompt: string }).prompt}`);
        return { optionId: "yes", status: "answered" };
      }),
      callId: "workflow-call",
    };
    attachWorkflowToolRunContext(runCtx, {
      from: { callId: "workflow-call", runId: "run-1" },
      host: { sleep: hostSleep },
      owner: { send: ownerSend },
    } as never);

    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        continuation,
        pending: [
          { action: { kind: "ask", request: { prompt: "Ship?" } }, id: "ask-1" },
          { action: { kind: "sleep", seconds: 1.25 }, id: "sleep-1" },
        ],
        progress: [{ stage: "waiting" }],
        status: "interrupted",
      })
      .mockResolvedValueOnce({
        logs: ["finished"],
        progress: [{ stage: "done" }],
        result: { ok: true },
        status: "completed",
      });

    await expect(runJsProgram("return 1", runCtx as never, options)).resolves.toEqual({
      logs: ["finished"],
      result: { ok: true },
    });
    expect(events[0]).toBe('report:{"stage":"waiting"}');
    expect(events).toContain("ask:Ship?");
    expect(events).toContain("sleep:1250");
    expect(events.at(-1)).toBe('report:{"stage":"done"}');
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: {
          continuation,
          resolutions: [
            {
              interruptionId: "ask-1",
              value: { output: { optionId: "yes", status: "answered" }, status: "completed" },
            },
            {
              interruptionId: "sleep-1",
              value: { output: { waitedSeconds: 1.25 }, status: "completed" },
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
        progress: [],
        status: "interrupted",
      })
      .mockResolvedValueOnce({
        logs: [],
        progress: [],
        result: ["one", "two"],
        status: "completed",
      });
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

  it("bounds total agent calls across resumed batches and surfaces catchable child failures", async () => {
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        continuation,
        pending: [pending],
        progress: [],
        status: "interrupted",
      })
      .mockResolvedValueOnce({
        continuation,
        pending: [pending, secondPending],
        progress: [],
        status: "interrupted",
      })
      .mockResolvedValueOnce({
        logs: [],
        progress: [],
        result: "limited",
        status: "completed",
      });
    reply.mockResolvedValueOnce("one").mockRejectedValueOnce(new Error("child failed"));

    await expect(runJsProgram("return 1", ctx, options)).resolves.toBe("limited");
    expect(reply).toHaveBeenCalledTimes(2);
    expect(mocks.runWorkflowProgramStep).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resume: expect.objectContaining({
          resolutions: [
            {
              interruptionId: "interrupt-1",
              value: { status: "failed", error: "child failed" },
            },
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
    const atLimit = "<".repeat(4 * 1024 * 1024 - 2);
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        continuation,
        pending: [pending, secondPending],
        progress: [],
        status: "interrupted",
      })
      .mockResolvedValueOnce({
        logs: [],
        progress: [],
        result: "caught",
        status: "completed",
      });
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

  it("reports completed-call warning, call summary, and capped console logs when the program fails", async () => {
    mocks.runWorkflowProgramStep
      .mockResolvedValueOnce({
        continuation,
        pending: [pending, secondPending],
        progress: [],
        status: "interrupted",
      })
      .mockResolvedValueOnce({
        error: "Error: bad state (line 4)",
        logs: ["first line", "x".repeat(5_000)],
        progress: [],
        status: "failed",
      });
    reply.mockResolvedValueOnce("one").mockRejectedValueOnce(new Error("boom"));

    const caught = await runJsProgram("return 1", ctx, options).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("Error: bad state (line 4)");
    expect(message).toContain("Calls that completed before this are not undone.");
    expect(message).toContain("Calls: 1 completed, 1 failed.");
    expect(message).toContain("\nconsole output:\nfirst line\n");
    const logBody = message.slice(
      message.indexOf("\nconsole output:\n") + "\nconsole output:\n".length,
    );
    expect(logBody.length).toBe(4_003);
    expect(logBody.endsWith("...")).toBe(true);
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

  it.each(["agent", "sleep"] as const)(
    "keeps owner cancellation terminal during %s calls",
    async (kind) => {
      const controller = new AbortController();
      const cancelledCtx = {
        abortSignal: controller.signal,
        agent,
        callId: "workflow-call",
      } as never;
      mocks.runWorkflowProgramStep.mockResolvedValueOnce({
        continuation,
        pending: [
          kind === "agent" ? pending : { action: { kind: "sleep", seconds: 60 }, id: "sleep-1" },
        ],
        progress: [],
        status: "interrupted",
      });
      if (kind === "agent") {
        reply.mockImplementation(async () => {
          controller.abort(new Error("owner cancelled"));
          throw new Error("child stopped");
        });
      } else {
        mocks.sleep.mockReturnValue(new Promise<void>(() => {}));
      }

      const running = runJsProgram("return 1", cancelledCtx, options);
      if (kind === "sleep") {
        await vi.waitFor(() => expect(mocks.sleep).toHaveBeenCalledWith(60_000));
        controller.abort(new Error("owner cancelled"));
      }

      await expect(running).rejects.toThrow("owner cancelled");
      expect(mocks.runWorkflowProgramStep).toHaveBeenCalledTimes(1);
    },
  );
});
