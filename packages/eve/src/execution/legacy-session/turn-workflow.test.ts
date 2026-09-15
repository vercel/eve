import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { turnWorkflow } from "./turn-workflow.js";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  claim: vi.fn(),
  aliases: vi.fn(),
  interrupt: vi.fn(),
  run: vi.fn(),
  fail: vi.fn(),
  dispose: vi.fn(),
  complete: vi.fn(),
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  getWorkflowMetadata: () => ({ workflowRunId: "owner" }),
}));
vi.mock("#execution/session-inbox/inbox.js", () => ({
  createSessionInbox: () => ({ claimSessionHook: mocks.claim, dispose: mocks.dispose }),
  claimSessionHooks: mocks.aliases,
}));
vi.mock("#execution/session-program.js", () => ({
  runPreparedSession: mocks.run,
  failSession: mocks.fail,
}));
vi.mock("./prepare-step.js", () => ({ prepareLegacySessionStep: mocks.prepare }));
vi.mock("./interrupt-step.js", () => ({ interruptLegacySessionStep: mocks.interrupt }));
vi.mock("./completion-step.js", () => ({ completeLegacyDriverStep: mocks.complete }));
const prepared = {
  sessionState: { sessionId: "original" },
  serializedContext: {},
  input: {
    delivery: { kind: "deliver", payloads: [{ message: "Continue" }], caller: {} },
    parentWritable: {},
    mode: "conversation",
  },
  hooks: { stable: "current-inbox", aliases: [] },
  deploymentId: "new",
  sessionTimeoutMs: 5000,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(10_000);
  mocks.prepare.mockResolvedValue(prepared);
  mocks.interrupt.mockResolvedValue({ sessionState: prepared.sessionState, serializedContext: {} });
  mocks.run.mockResolvedValue({ output: "done" });
  mocks.fail.mockRejectedValue(new Error("session failed"));
});
afterEach(() => vi.restoreAllMocks());
describe("legacy import ownership", () => {
  it("prepares before claiming, and waits for the whole session before releasing the driver", async () => {
    let finish!: (value: unknown) => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const work = turnWorkflow({});
    await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledOnce());
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claim.mock.invocationCallOrder[0]!,
    );
    expect(mocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.interrupt.mock.invocationCallOrder[0]!,
    );
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        caller: undefined,
        initialInput: {
          kind: "deliver",
          payloads: [{ message: "Continue" }],
          caller: undefined,
        },
        ownership: {
          anchorRunId: "original",
          sessionId: "original",
          ownerRunId: "owner",
          deploymentId: "new",
        },
        sessionWritable: prepared.input.parentWritable,
        sessionTimeoutMs: prepared.sessionTimeoutMs,
        sessionTimeoutDeadline: new Date(15_000),
      }),
      expect.anything(),
    );
    finish({ output: "done", usage: { inputTokens: 12 } });
    await work;
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({
      prepared,
      result: { output: "done", usage: { inputTokens: 12 } },
    });
  });
  it("a losing duplicate neither interrupts work nor completes the driver", async () => {
    mocks.claim.mockRejectedValue(Object.assign(new Error("owned"), { name: "HookConflictError" }));
    await turnWorkflow({});
    expect(mocks.interrupt).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("preparation failure never publishes an inbox or acknowledges the driver", async () => {
    mocks.prepare.mockRejectedValue(new Error("snapshot unavailable"));
    await expect(turnWorkflow({})).rejects.toThrow("snapshot unavailable");
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("an initialization failure after election emits failure and releases the original driver", async () => {
    mocks.interrupt.mockRejectedValue(new Error("interruption failed"));
    await expect(turnWorkflow({})).rejects.toThrow("session failed");
    expect(mocks.fail).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({
      prepared,
      result: { output: "", isError: true },
    });
  });
  it("preserves a failed terminal outcome without another finalizer", async () => {
    mocks.run.mockResolvedValue({ output: "failed", isError: true });
    await turnWorkflow({});
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledExactlyOnceWith({
      prepared,
      result: { output: "failed", isError: true },
    });
  });
  it("does not emit another terminal event after a runner failure", async () => {
    mocks.run.mockRejectedValue(new Error("runner failed"));
    await expect(turnWorkflow({})).rejects.toThrow("runner failed");
    expect(mocks.fail).not.toHaveBeenCalled();
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
});
