import { describe, expect, it, vi } from "vitest";

import type { TurnCaller } from "#channel/types.js";
import { finalizeSession } from "#execution/session/finalization.js";
import { failSession } from "#execution/session/program.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { cancelTasksStep } from "#tasks/cancel.js";
import { notifyTurnCallerStep, resolveInitialTurnCallerStep } from "#tasks/child.js";

vi.mock("#tasks/child.js", async (importOriginal) => ({
  ...(await importOriginal()),
  notifyTurnCallerStep: vi.fn(),
  resolveInitialTurnCallerStep: vi.fn(),
}));
vi.mock("#tasks/cancel.js", async (importOriginal) => ({
  ...(await importOriginal()),
  cancelTasksStep: vi.fn(),
}));
vi.mock("#execution/session/finalization.js", () => ({ finalizeSession: vi.fn() }));

const CALLER: TurnCaller = {
  callId: "call-delegate",
  replyTo: { kind: "hook", token: "owner-inbox" },
  subagentName: "researcher",
};

describe("failSession", () => {
  it("cancels the session's working tasks before its caller learns it failed", async () => {
    const sessionState = createTestSessionState({ sessionId: "child" });
    vi.mocked(resolveInitialTurnCallerStep).mockResolvedValue(CALLER);
    vi.mocked(finalizeSession).mockResolvedValue({
      callerReply: { isError: true, output: "boot failed" },
      result: { isError: true, output: "boot failed" },
    });

    await expect(
      failSession({
        error: new Error("boot failed"),
        mode: "conversation",
        serializedContext: {},
        sessionId: "child",
        sessionState,
        sessionWritable: new WritableStream<Uint8Array>(),
      }),
    ).rejects.toThrow("Agent workflow failed.");

    expect(cancelTasksStep).toHaveBeenCalledExactlyOnceWith({
      selector: { kind: "all" },
      serializedContext: {},
      sessionState,
    });
    expect(notifyTurnCallerStep).toHaveBeenCalledExactlyOnceWith({
      caller: CALLER,
      lifecycle: "terminal",
      sessionId: "child",
      settled: { isError: true, output: "boot failed" },
    });
    expect(vi.mocked(cancelTasksStep).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(notifyTurnCallerStep).mock.invocationCallOrder[0]!,
    );
  });
});
