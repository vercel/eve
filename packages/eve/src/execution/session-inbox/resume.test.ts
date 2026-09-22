import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";

const resumeHookMock = vi.fn();
const getHookMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
  getHookByToken: (...args: unknown[]) => getHookMock(...args),
}));

afterEach(() => {
  resumeHookMock.mockReset();
  getHookMock.mockReset();
  vi.useRealTimers();
});

describe("session inbox resume", () => {
  it("delivers a workflow request to the successor after a handoff gap", async () => {
    vi.useFakeTimers();
    const token = sessionCommandHookToken("session-1");
    const message = {
      kind: "request" as const,
      from: {
        callId: "call-1",
        execution: "background" as const,
        input: {},
        runId: "run-1",
        sequence: 0,
        stepIndex: 0,
        toolName: "probe",
        turnId: "turn-1",
      },
      replyTo: "eve.sandbox.step-1",
      request: { kind: "sandbox-request" as const, taskId: "task-1" },
    };
    resumeHookMock
      .mockRejectedValueOnce(new HookNotFoundError(token))
      .mockResolvedValueOnce(sessionHook("successor", token, { sessionId: "session-1" }));
    getHookMock.mockResolvedValue({ runId: "previous-owner" });
    const delivery = resumeSessionInbox(token, message);
    await vi.advanceTimersByTimeAsync(20);
    expect((await delivery).ownerRunId).toBe("successor");
    expect(resumeHookMock.mock.calls).toEqual([
      [sessionInboxHookToken(token), message],
      [sessionInboxHookToken(token), message],
    ]);
  });

  it("resumes the current owner while preserving public session identity", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    const receipt = await resumeSessionInbox(token, { kind: "clear" });
    expect(receipt.ownerRunId).toBe("owner-2");
    await expect(receipt.sessionId).resolves.toBe("session-1");
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), { kind: "clear" });
  });

  it("resolves a saved public address through the stable token", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox({ sessionId: "session-1" }, { kind: "compact" });
    expect(resumeHookMock).toHaveBeenCalledWith(sessionInboxHookToken(token), { kind: "compact" });
  });
  it("does not hydrate metadata until an accepted alias caller asks for identity", async () => {
    const metadata = vi.fn(() => Promise.resolve({ sessionId: "anchor" }));
    const acceptance = Promise.withResolvers<{
      readonly runId: string;
      readonly metadata: Promise<unknown>;
    }>();
    resumeHookMock.mockReturnValue(acceptance.promise);
    const delivery = resumeSessionInbox("channel:alias", { kind: "clear" });
    expect(metadata).not.toHaveBeenCalled();
    acceptance.resolve({
      runId: "successor",
      get metadata() {
        return metadata();
      },
    });
    const receipt = await delivery;
    expect(metadata).not.toHaveBeenCalled();
    await expect(receipt.sessionId).resolves.toBe("anchor");
    await expect(receipt.sessionId).resolves.toBe("anchor");
    expect(metadata).toHaveBeenCalledOnce();
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });

  it("never reads metadata for a known session address", async () => {
    resumeHookMock.mockResolvedValue({
      runId: "successor",
      get metadata() {
        throw new Error("Metadata must not be read");
      },
    });
    const receipt = await resumeSessionInbox({ sessionId: "anchor" }, { kind: "clear" });
    await expect(receipt.sessionId).resolves.toBe("anchor");
  });

  it("does not substitute the executor for missing session identity", async () => {
    resumeHookMock.mockResolvedValue({ runId: "successor", metadata: Promise.resolve(undefined) });
    const receipt = await resumeSessionInbox("alias", { kind: "clear" });
    await expect(receipt.sessionId).rejects.toThrow("command accepted");
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });
});

function sessionHook(runId: string, token: string, metadata: Record<string, unknown>) {
  return { metadata: Promise.resolve(metadata), runId, token };
}
