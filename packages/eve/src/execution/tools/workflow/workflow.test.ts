import { afterEach, expect, it, vi } from "vitest";
import { createChannelReader } from "#execution/tools/workflow/owner-channels.js";
import { workflowToolRunWorkflow } from "#execution/tools/workflow/workflow.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

const mocks = vi.hoisted(() => ({
  control: vi.fn(),
  invocation: vi.fn(),
  deliver: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({ sleep: mocks.sleep }));
vi.mock("#execution/tools/workflow/run-control.js", () => ({
  openWorkflowToolRunControlInbox: mocks.control,
}));
vi.mock("#execution/tools/workflow/invocation.js", () => ({
  createWorkflowToolInvocationReader: mocks.invocation,
}));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.deliver,
}));
vi.mock("#execution/tools/workflow/body.js", () => ({
  createWorkflowBodyRef: () => from,
}));

const from = {
  callId: "call",
  execution: "blocking" as const,
  input: {},
  runId: "run",
  sequence: 0,
  stepIndex: 0,
  toolName: "worker",
  turnId: "turn",
};
const input = {
  callId: "call",
  hookToken: "control",
  input: {},
  owner: { inbox: "owner" },
  session: {
    auth: { current: null, initiator: null },
    id: "session",
    turn: { id: "turn", sequence: 0 },
  },
  stepIndex: 0,
  toolName: "worker",
  workflowId: "workflow//worker",
};

afterEach(() => vi.resetAllMocks());

it.each(["completed", "failed", "cancelled", "throw", "blocked"] as const)(
  "keeps cancellation final when cleanup is %s",
  async (status) => {
    const controller = new AbortController();
    const cancelled = Promise.withResolvers<never>();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    mocks.control.mockReturnValue({
      signal: controller.signal,
      cancelled: cancelled.promise,
      reason: () => "stop",
    });
    mocks.sleep.mockImplementation(async () => {
      if (status === "blocked") return;
      await new Promise<void>(() => {});
    });
    mocks.invocation.mockReturnValue(
      createChannelReader(
        "workflow",
        (async function* (): AsyncGenerator<WorkflowToolRunMessage> {
          started.resolve();
          await release.promise;
          if (status === "throw") throw new Error("cleanup failed");
          yield {
            from,
            kind: "outcome",
            result:
              status === "failed"
                ? { status, error: { name: "Error", message: "failed" } }
                : status === "cancelled"
                  ? { status, reason: "body cancelled" }
                  : { status: "completed", output: "late success" },
          };
        })(),
      ),
    );
    const running = workflowToolRunWorkflow(input);
    await started.promise;
    controller.abort(new Error("stop"));
    cancelled.reject(controller.signal.reason);
    if (status !== "blocked") release.resolve();
    await running;
    expect(mocks.deliver).toHaveBeenCalledExactlyOnceWith(
      "owner",
      {
        from,
        kind: "outcome",
        result: { status: "cancelled", reason: "stop" },
      },
      { ifPresent: true },
    );
  },
);
