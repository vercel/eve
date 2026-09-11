import { afterEach, describe, expect, it, vi } from "vitest";

import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";

const getHookByTokenMock = vi.fn();
const resumeHookMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

afterEach(() => {
  getHookByTokenMock.mockReset();
  resumeHookMock.mockReset();
});

describe("session inbox resume", () => {
  it("resumes the current owner while preserving public session identity", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    getHookByTokenMock.mockResolvedValue(hook);

    await expect(resumeSessionInbox(token, { kind: "clear" })).resolves.toEqual({
      ownerRunId: "owner-2",
      sessionId: "session-1",
    });
    expect(resumeHookMock).toHaveBeenCalledWith(hook, { kind: "clear" });
  });

  it("resolves a saved public address through the stable token", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("owner-2", token, { sessionId: "session-1" });
    getHookByTokenMock.mockResolvedValue(hook);

    await resumeSessionInbox({ sessionId: "session-1" }, { kind: "compact" });
    expect(getHookByTokenMock).toHaveBeenCalledWith(token);
  });
});

function sessionHook(runId: string, token: string, metadata: Record<string, unknown>) {
  return { metadata: Promise.resolve(metadata), runId, token };
}
