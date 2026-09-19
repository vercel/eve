import { describe, expect, it, vi } from "vitest";
import {
  requestWorkflowSandbox,
  type WorkflowSandboxResponse,
} from "#execution/sandbox/workflow-request.js";
import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";

const mocks = vi.hoisted(() => ({ getRun: vi.fn(), resumeHook: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => mocks);
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getStepMetadata: () => ({ stepId: "step-1" }),
}));

const run: WorkflowToolRunContext = {
  owner: { inbox: "owner" },
  from: {
    callId: "call-1",
    execution: "blocking",
    input: {},
    runId: "run-1",
    sequence: 0,
    stepIndex: 0,
    toolName: "probe",
    turnId: "turn-1",
  },
};

describe("workflow sandbox request", () => {
  it("reuses the durable response when an authored step retries", async () => {
    let response: WorkflowSandboxResponse | undefined;
    let controller: ReadableStreamDefaultController<WorkflowSandboxResponse>;
    const reference = {
      compiledArtifactsSource: { kind: "bundled" as const },
      nodeId: "root",
      sessionId: "session-1",
      state: null,
    };
    mocks.getRun.mockReturnValue({
      getReadable: () =>
        Object.assign(
          new ReadableStream<WorkflowSandboxResponse>({
            start(next) {
              controller = next;
              if (response !== undefined) {
                next.enqueue(response);
                next.close();
              }
            },
          }),
          { getTailIndex: async () => (response === undefined ? -1 : 0) },
        ),
    });
    mocks.resumeHook.mockReset().mockImplementation(async () => {
      response = { reference };
      controller.enqueue(response);
      controller.close();
    });
    const input = { run, abortSignal: new AbortController().signal };
    expect(await requestWorkflowSandbox(input)).toEqual(reference);
    expect(await requestWorkflowSandbox(input)).toEqual(reference);
    expect(mocks.resumeHook).toHaveBeenCalledExactlyOnceWith("owner", {
      kind: "request",
      from: run.from,
      replyTo: "eve.sandbox.step-1",
      request: { kind: "sandbox-request" },
    });
  });

  it("cancels a pending response read when the step is aborted", async () => {
    const cancelled = vi.fn();
    mocks.getRun.mockReturnValue({
      getReadable: () =>
        Object.assign(new ReadableStream({ cancel: cancelled }), { getTailIndex: async () => -1 }),
    });
    const controller = new AbortController();
    mocks.resumeHook
      .mockReset()
      .mockImplementation(async () => controller.abort(new Error("cancelled")));
    await expect(requestWorkflowSandbox({ run, abortSignal: controller.signal })).rejects.toThrow(
      "cancelled",
    );
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
