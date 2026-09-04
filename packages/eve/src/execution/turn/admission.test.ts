import { beforeEach, describe, expect, it, vi } from "vitest";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
const mocks = vi.hoisted(() => ({ getRun: vi.fn(), resumeHook: vi.fn() }));
vi.mock("#internal/workflow/runtime.js", () => mocks);
import { forwardSubmissionStep, waitForTurnReceipt } from "#execution/turn/admission.js";

describe("turn admission receipts", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  it("waits for the owner actually resumed and leaves continuation traversal to the candidate", async () => {
    mocks.resumeHook.mockResolvedValue({ runId: "actual-owner" });
    const receipt = { continuedTo: "waits-for-candidate", deliveries: {}, terminal: false };
    mocks.getRun.mockReturnValue({ returnValue: Promise.resolve(receipt) });
    const submission = { eventId: "event", command: { kind: "clear" as const } };
    await expect(
      forwardSubmissionStep({ token: "active", candidateRunId: "candidate", submission }),
    ).resolves.toEqual(receipt);
    expect(mocks.getRun).toHaveBeenCalledExactlyOnceWith("actual-owner");
    expect(mocks.resumeHook).toHaveBeenCalledWith("active", {
      eventId: "event",
      kind: "session.submit",
      payload: { candidateRunId: "candidate", submission },
    });
  });
  it("returns to admission when the observed hook disappeared", async () => {
    mocks.resumeHook.mockRejectedValue(new HookNotFoundError("gone"));
    await expect(
      forwardSubmissionStep({
        token: "active",
        candidateRunId: "candidate",
        submission: { eventId: "event", command: { kind: "clear" } },
      }),
    ).resolves.toBeUndefined();
  });
  it("follows durable deferrals when awaiting a public result", async () => {
    mocks.getRun.mockImplementation((runId: string) => ({
      returnValue: Promise.resolve(
        runId === "first"
          ? { continuedTo: "second", deliveries: {}, terminal: false }
          : { deliveries: { event: "applied" }, terminal: false },
      ),
    }));
    await expect(waitForTurnReceipt("first")).resolves.toEqual({
      deliveries: { event: "applied" },
      terminal: false,
    });
    expect(mocks.getRun.mock.calls).toEqual([["first"], ["second"]]);
  });
  it("rejects continuation cycles instead of awaiting indefinitely", async () => {
    mocks.getRun.mockReturnValue({
      returnValue: Promise.resolve({ continuedTo: "first", deliveries: {}, terminal: false }),
    });
    await expect(waitForTurnReceipt("first")).rejects.toThrow("Invalid turn continuation chain");
  });
});
