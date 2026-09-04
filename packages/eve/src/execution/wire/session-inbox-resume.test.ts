import { afterEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { SESSION_INBOX_WIRE_VERSIONS } from "#execution/wire/session-inbox-contract.js";
import {
  resolveSessionInboxWireTarget,
  resumeSessionInbox,
} from "#execution/wire/session-inbox-resume.js";

const getHookByTokenMock = vi.fn();
const resumeHookMock = vi.fn();
const getHookRecordByTokenMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  getHookRecordByToken: (...args: unknown[]) => getHookRecordByTokenMock(...args),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

afterEach(() => {
  getHookByTokenMock.mockReset();
  getHookRecordByTokenMock.mockReset();
  resumeHookMock.mockReset();
});

describe("session inbox target resolution", () => {
  it.each(SESSION_INBOX_WIRE_VERSIONS)(
    "uses wire version %i advertised by a stamped hook",
    async (version) => {
      const hook = sessionHook("session-1", "channel-1", {
        sessionInboxWireVersion: version,
      });

      await expect(resolveSessionInboxWireTarget(hook)).resolves.toEqual({ version });
      expect(getHookByTokenMock).not.toHaveBeenCalled();
    },
  );

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
        sessionHook("session-1", "continuation-1", { sessionInboxWireVersion: 99 }),
      ),
    ).rejects.toThrow(/unsupported wire version 99/);
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });
});

describe("resumeSessionInbox", () => {
  it.each([
    { kind: "send", payload: { message: "follow-up" } },
    { kind: "cancel", turnId: "turn-1" },
    { kind: "clear" },
    { kind: "compact" },
    { kind: "reset" },
    { kind: "session-timeout" },
  ] as const)("sends $kind to a stable inbox without an explicit lookup", async (command) => {
    const token = sessionCommandHookToken("session-1");
    resumeHookMock.mockResolvedValue(sessionHook("session-1", token));
    await resumeSessionInbox(token, command);
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(getHookRecordByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(token, expect.objectContaining(command));
    expect(resumeHookMock.mock.calls[0]![1]).not.toHaveProperty("version");
  });

  it("preserves caller observers without reading metadata", async () => {
    const token = sessionCommandHookToken("session-1");
    const caller = {
      activityObserver: { sink: { url: "https://example.com/activity", version: 1 as const } },
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "reply-1" },
      subagentName: "researcher",
    };
    await resumeSessionInbox(token, { caller, kind: "send", payload: { message: "hello" } });
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(getHookRecordByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledWith(token, expect.objectContaining({ caller }));
  });

  it("does not decrypt an existing alias stamp to deliver a compatible message", async () => {
    const hook = sessionHook("session-1", "channel-1", new Uint8Array([1, 2, 3]));
    getHookRecordByTokenMock.mockResolvedValue(hook);
    await resumeSessionInbox("channel-1", { kind: "send", payload: { message: "hello" } });
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(getHookRecordByTokenMock).toHaveBeenCalledExactlyOnceWith("channel-1");
    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
      hook,
      expect.objectContaining({
        kind: "deliver",
        payloads: [{ message: "hello" }],
      }),
    );
    expect(resumeHookMock.mock.calls[0]![1]).not.toHaveProperty("version");
  });

  it.each([
    ["current", new Uint8Array([1]), "deliver"],
    ["pre-stamp stable-inbox", undefined, "send"],
  ] as const)(
    "classifies a markerless alias owned by a %s parent without decryption",
    async (_name, metadata, kind) => {
      const hook = sessionHook("session-1", "channel-1");
      getHookRecordByTokenMock
        .mockResolvedValueOnce(hook)
        .mockResolvedValueOnce(
          sessionHook("session-1", sessionCommandHookToken("session-1"), metadata),
        );
      await resumeSessionInbox("channel-1", { kind: "send", payload: { message: "hello" } });
      expect(getHookByTokenMock).not.toHaveBeenCalled();
      expect(getHookRecordByTokenMock).toHaveBeenNthCalledWith(
        2,
        sessionCommandHookToken("session-1"),
      );
      expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
        hook,
        expect.objectContaining({ kind }),
      );
    },
  );

  it("retains the deliver-only envelope for parents predating stable inboxes", async () => {
    const hook = sessionHook("session-1", "channel-1");
    getHookRecordByTokenMock
      .mockResolvedValueOnce(hook)
      .mockRejectedValueOnce(new HookNotFoundError(sessionCommandHookToken("session-1")));
    await resumeSessionInbox("channel-1", { kind: "send", payload: { message: "hello" } });
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
      hook,
      expect.objectContaining({ kind: "deliver" }),
    );
  });

  it("does not persist when a historical ownership probe fails unexpectedly", async () => {
    const failure = new Error("world unavailable");
    getHookRecordByTokenMock
      .mockResolvedValueOnce(sessionHook("session-1", "channel-1"))
      .mockRejectedValueOnce(failure);
    await expect(resumeSessionInbox("channel-1", { kind: "clear" })).rejects.toBe(failure);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("does not retry delivery after an ambiguous wake failure", async () => {
    const failure = new Error("wake failed after persistence");
    resumeHookMock.mockRejectedValue(failure);
    await expect(
      resumeSessionInbox(sessionCommandHookToken("session-1"), { kind: "clear" }),
    ).rejects.toBe(failure);
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });

  it("negotiates only session-owned task cancellation", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("session-1", token, { sessionInboxWireVersion: 6 });
    getHookByTokenMock.mockResolvedValue(hook);
    await resumeSessionInbox(token, { kind: "cancel", tasks: true });
    expect(getHookRecordByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledWith(hook, {
      kind: "cancel",
      tasks: true,
      turnId: undefined,
      version: 6,
    });
  });

  it("resolves task cancellation capability through a metadata-free alias", async () => {
    const hook = sessionHook("session-1", "channel-1");
    getHookByTokenMock.mockResolvedValueOnce(hook).mockResolvedValueOnce(
      sessionHook("session-1", sessionCommandHookToken("session-1"), {
        sessionInboxWireVersion: 6,
      }),
    );
    await resumeSessionInbox("channel-1", { kind: "cancel", tasks: true });
    expect(resumeHookMock).toHaveBeenCalledWith(
      hook,
      expect.objectContaining({ tasks: true, version: 6 }),
    );
  });

  it.each([undefined, { sessionInboxWireVersion: 5 }])(
    "rejects a task cancellation unsupported by the pinned parent",
    async (metadata) => {
      const token = sessionCommandHookToken("session-1");
      getHookByTokenMock.mockResolvedValue(sessionHook("session-1", token, metadata));
      await expect(resumeSessionInbox(token, { kind: "cancel", tasks: true })).rejects.toThrow(
        /Cannot encode session-owned task cancellation/,
      );
      expect(resumeHookMock).not.toHaveBeenCalled();
    },
  );
});

function sessionHook(runId: string, token: string, metadata?: unknown) {
  return { metadata, runId, token } as never;
}
