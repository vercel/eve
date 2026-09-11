import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";

const resumeHookMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

afterEach(() => {
  resumeHookMock.mockReset();
});

describe("session inbox resume", () => {
  it("resumes the current owner while preserving public session identity", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    const receipt = await resumeSessionInbox(token, { kind: "clear" });
    expect(receipt.ownerRunId).toBe("owner-2");
    await expect(receipt.sessionId).resolves.toBe("session-1");
    expect(resumeHookMock).toHaveBeenCalledWith(token, { kind: "clear" });
  });

  it("resolves a saved public address through the stable token", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox({ sessionId: "session-1" }, { kind: "compact" });
    expect(resumeHookMock).toHaveBeenCalledWith(token, { kind: "compact" });
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
