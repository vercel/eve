import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEnvelope } from "#execution/inbox/types.js";
import type { WorkflowToolRunInput } from "#execution/workflow-tool/types.js";
const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  next: vi.fn(),
  observe: vi.fn(),
  dispose: vi.fn(),
  stop: vi.fn(),
  publish: vi.fn(),
  send: vi.fn(),
  body: vi.fn(),
  watch: vi.fn(),
}));
vi.mock("#execution/inbox/owner.js", () => ({
  createOwnerInbox: () => ({
    address: { token: "tool", ownerRunId: "tool-run" },
    claim: mocks.claim,
    next: mocks.next,
    observe: mocks.observe,
    dispose: mocks.dispose,
  }),
}));
vi.mock("#execution/inbox/admission.js", () => ({ watchAdmissionOwnerStep: mocks.watch }));
vi.mock("#execution/inbox/readiness.js", () => ({ publishOwnerStep: mocks.publish }));
vi.mock("#execution/inbox/send.js", () => ({ sendInboxStep: mocks.send }));
vi.mock("#execution/workflow-tool/body.js", () => ({
  executeWorkflowBody: mocks.body,
  createWorkflowBodyRef: () => ({ runId: "tool-run", callId: "call" }),
}));
import { workflowToolRunWorkflow } from "#execution/workflow-tool/workflow.js";
const input = {
  hookToken: "tool",
  owner: { token: "turn", ownerRunId: "turn-run" },
} as WorkflowToolRunInput;

describe("workflow tool quiescence", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    mocks.claim.mockResolvedValue({ kind: "owned" });
    mocks.watch.mockImplementation(() => new Promise(() => {}));
    mocks.observe.mockReturnValue(mocks.stop);
    mocks.send.mockResolvedValue("delivered");
    mocks.next.mockResolvedValue({ eventId: "ready", kind: "tool.ready", payload: {} });
  });
  afterEach(() => vi.useRealTimers());
  it("disposes without authored work when closure precedes admission", async () => {
    mocks.watch.mockResolvedValue(undefined);
    mocks.next.mockResolvedValue({ eventId: "closed", kind: "admission.closed", payload: null });
    await workflowToolRunWorkflow(input);
    expect(mocks.watch).toHaveBeenCalledExactlyOnceWith("turn-run", {
      token: "tool",
      ownerRunId: "tool-run",
    });
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("retains its pending read when marker delivery finishes first", async () => {
    const event = Promise.withResolvers<InboxEnvelope>();
    mocks.next.mockReturnValueOnce(event.promise);
    mocks.watch.mockResolvedValue(undefined);
    mocks.body.mockResolvedValue({ status: "completed", output: "done" });
    const run = workflowToolRunWorkflow(input);
    await vi.advanceTimersByTimeAsync(0);
    event.resolve({ eventId: "ready", kind: "tool.ready", payload: {} });
    await run;
    expect(mocks.next).toHaveBeenCalledOnce();
    expect(mocks.body).toHaveBeenCalledOnce();
  });
  it("surfaces failed closure-marker delivery before admission", async () => {
    mocks.next.mockImplementation(() => new Promise(() => {}));
    mocks.watch.mockRejectedValue(new Error("marker write failed"));
    await expect(workflowToolRunWorkflow(input)).rejects.toThrow("marker write failed");
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it("does not abort an admitted body when its initiating owner completes", async () => {
    const owner = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<{ status: "completed"; output: string }>();
    mocks.watch.mockReturnValue(owner.promise);
    mocks.body.mockImplementation(() => {
      started.resolve();
      return finished.promise;
    });
    const run = workflowToolRunWorkflow(input);
    await started.promise;
    owner.resolve();
    await Promise.resolve();
    expect(mocks.body.mock.calls[0]![1].aborted).toBe(false);
    expect(mocks.dispose).not.toHaveBeenCalled();
    finished.resolve({ status: "completed", output: "done" });
    await run;
    expect(mocks.send.mock.calls[0]![1].payload.result.status).toBe("completed");
  });
  it.each(["cancellation", "reader failure"])(
    "holds ownership through slow authored cleanup after %s",
    async (cause) => {
      let finish!: (outcome: { status: "completed"; output: string }) => void;
      mocks.body.mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      const run = workflowToolRunWorkflow(input);
      await vi.advanceTimersByTimeAsync(0);
      if (cause === "cancellation") {
        const observe = mocks.observe.mock.calls[0]![0] as (envelope: InboxEnvelope) => void;
        observe({ eventId: "cancel", kind: "tool.cancel", payload: { reason: "cancelled" } });
      } else {
        mocks.observe.mock.calls[0]![1](new Error("reader failed"));
      }
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.body.mock.calls[0]![1].aborted).toBe(true);
      expect(mocks.send).not.toHaveBeenCalled();
      expect(mocks.dispose).not.toHaveBeenCalled();
      finish({ status: "completed", output: "cleanup finished" });
      await run;
      expect(mocks.send).toHaveBeenCalledWith(
        input.owner,
        expect.objectContaining({
          payload: expect.objectContaining({
            result: expect.objectContaining({
              status: cause === "cancellation" ? "cancelled" : "failed",
            }),
          }),
        }),
      );
      expect(mocks.dispose).toHaveBeenCalledOnce();
      expect(mocks.stop).toHaveBeenCalledOnce();
    },
  );
  it("waits for committed parent admission and skips authored work when cancelled first", async () => {
    let deliver!: (event: InboxEnvelope) => void;
    mocks.next.mockReturnValue(
      new Promise((resolve) => {
        deliver = resolve;
      }),
    );
    const run = workflowToolRunWorkflow(input);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.body).not.toHaveBeenCalled();
    const event: InboxEnvelope = {
      eventId: "cancel",
      kind: "tool.cancel",
      payload: { reason: "creation failed" },
    };
    mocks.observe.mock.calls[0]![0](event);
    deliver(event);
    await run;
    expect(mocks.body).not.toHaveBeenCalled();
    expect(mocks.send.mock.calls[0]![1].payload.result.status).toBe("cancelled");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
