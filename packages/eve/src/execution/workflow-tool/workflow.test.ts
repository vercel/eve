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
    mocks.observe.mockReturnValue(mocks.stop);
    mocks.send.mockResolvedValue("delivered");
    mocks.next.mockResolvedValue({ eventId: "ready", kind: "tool.ready", payload: {} });
  });
  afterEach(() => vi.useRealTimers());
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
