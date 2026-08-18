import { afterEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  resolveSessionInboxWireTarget,
  resumeSessionInbox,
} from "#execution/wire/session-inbox-resume.js";

const getHookByTokenMock = vi.fn();
const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

afterEach(() => {
  getHookByTokenMock.mockReset();
  resumeHookMock.mockReset();
});

describe("session inbox target resolution", () => {
  it("uses the wire version advertised by a current hook", async () => {
    const hook = sessionHook("session-1", "channel-1", { sessionInboxWireVersion: 1 });

    await expect(resolveSessionInboxWireTarget(hook)).resolves.toEqual({ version: 1 });
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });

  it("selects raw send for a markerless stable hook", async () => {
    const token = sessionCommandHookToken("session-1");

    await expect(resolveSessionInboxWireTarget(sessionHook("session-1", token))).resolves.toEqual({
      variant: "send",
      version: 0,
    });
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });

  it("selects raw send for a markerless continuation owned by the stable-inbox cohort", async () => {
    getHookByTokenMock.mockResolvedValue(
      sessionHook("session-1", sessionCommandHookToken("session-1")),
    );

    await expect(
      resolveSessionInboxWireTarget(sessionHook("session-1", "continuation-1")),
    ).resolves.toEqual({ variant: "send", version: 0 });
  });

  it("selects deliver for a markerless continuation without a stable inbox", async () => {
    getHookByTokenMock.mockRejectedValue(
      new HookNotFoundError(sessionCommandHookToken("session-1")),
    );

    await expect(
      resolveSessionInboxWireTarget(sessionHook("session-1", "continuation-1")),
    ).resolves.toEqual({ variant: "deliver", version: 0 });
  });

  it("rejects an advertised unknown version before persistence", async () => {
    await expect(
      resolveSessionInboxWireTarget(
        sessionHook("session-1", "continuation-1", { sessionInboxWireVersion: 2 }),
      ),
    ).rejects.toThrow(/unsupported wire version 2/);
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });
});

describe("resumeSessionInbox", () => {
  it("encodes for the resolved consumer and resumes the exact inspected hook", async () => {
    const hook = sessionHook("session-1", "continuation-1", { sessionInboxWireVersion: 1 });
    getHookByTokenMock.mockResolvedValue(hook);
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox("continuation-1", {
      kind: "send",
      payload: { message: "follow-up" },
    });

    expect(getHookByTokenMock).toHaveBeenCalledWith("continuation-1");
    expect(resumeHookMock).toHaveBeenCalledWith(hook, {
      auth: undefined,
      caller: undefined,
      kind: "deliver",
      payload: { message: "follow-up" },
      payloads: [{ message: "follow-up" }],
      requestId: undefined,
      version: 1,
    });
  });
});

function sessionHook(runId: string, token: string, metadata?: unknown) {
  return { metadata, runId, token } as never;
}
