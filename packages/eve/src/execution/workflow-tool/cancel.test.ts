import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ send: vi.fn(), getRun: vi.fn() }));
vi.mock("#execution/inbox/send.js", () => ({ sendInbox: mocks.send }));
vi.mock("#internal/workflow/runtime.js", () => ({ getRun: mocks.getRun }));
import { cancelWorkflowToolRun } from "#execution/workflow-tool/cancel.js";

describe("workflow tool cancellation", () => {
  it("waits for durable completion after sending cooperative cancellation", async () => {
    let finish!: () => void;
    mocks.send.mockResolvedValue("delivered");
    mocks.getRun.mockReturnValue({
      returnValue: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });
    const ended = vi.fn();
    const cancelled = cancelWorkflowToolRun({ hookToken: "tool", runId: "run" }, "cancelled").then(
      ended,
    );
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(mocks.send).toHaveBeenCalledWith(
      { token: "tool", ownerRunId: "run" },
      { eventId: "run:cancel", kind: "tool.cancel", payload: { reason: "cancelled" } },
    );
    expect(ended).not.toHaveBeenCalled();
    finish();
    await cancelled;
    expect(ended).toHaveBeenCalledOnce();
  });
});
