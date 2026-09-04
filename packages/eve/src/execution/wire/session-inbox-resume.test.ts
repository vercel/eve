import { afterEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { SESSION_INBOX_WIRE_VERSIONS } from "#execution/wire/session-inbox-contract.js";
import {
  resolveSessionInboxWireTarget,
  resumeSessionInbox,
} from "#execution/wire/session-inbox-resume.js";

const getHookByTokenMock = vi.fn();
const getRawHookByTokenMock = vi.fn();
const resumeHookMock = vi.fn();

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  getHookByToken: (...args: unknown[]) => getHookByTokenMock(...args),
  getWorld: async () => ({ hooks: { getByToken: getRawHookByTokenMock } }),
  resumeHook: (...args: unknown[]) => resumeHookMock(...args),
}));

afterEach(() => {
  getHookByTokenMock.mockReset();
  getRawHookByTokenMock.mockReset();
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
    getRawHookByTokenMock.mockResolvedValue(
      sessionHook("session-1", sessionCommandHookToken("session-1")),
    );

    await expect(
      resolveSessionInboxWireTarget(sessionHook("session-1", "continuation-1")),
    ).resolves.toEqual({ variant: "send", version: 0 });
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a stable inbox belonging to a different run without hydrating its metadata", async () => {
    getRawHookByTokenMock.mockResolvedValue({ runId: "different-run" });

    await expect(
      resolveSessionInboxWireTarget(sessionHook("session-1", "continuation-1")),
    ).rejects.toThrow(/belongs to run "different-run", expected "session-1"/);
    expect(getHookByTokenMock).not.toHaveBeenCalled();
  });

  it("selects deliver for a markerless continuation without a stable inbox", async () => {
    getRawHookByTokenMock.mockRejectedValue(
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
  it("resumes a compatible stable inbox by token without inspecting metadata", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("session-1", token, { sessionInboxWireVersion: 2 });
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox(token, {
      kind: "send",
      payload: { message: "follow-up" },
    });

    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledWith(token, {
      auth: undefined,
      caller: undefined,
      delivery: undefined,
      kind: "send",
      payload: { message: "follow-up" },
      requestId: undefined,
      taskDeliveryId: undefined,
      turnPolicy: undefined,
    });
  });

  it("strips an undefined activity observer from the stable fast path", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("session-1", token, { sessionInboxWireVersion: 2 });
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox(token, {
      caller: {
        activityObserver: undefined,
        callId: "call-1",
        replyTo: { kind: "hook", token: "reply-1" },
        subagentName: "researcher",
      },
      kind: "send",
      payload: { message: "follow-up" },
    });

    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledWith(token, {
      auth: undefined,
      caller: {
        callId: "call-1",
        replyTo: { kind: "hook", token: "reply-1" },
        subagentName: "researcher",
      },
      delivery: undefined,
      kind: "send",
      payload: { message: "follow-up" },
      requestId: undefined,
      taskDeliveryId: undefined,
      turnPolicy: undefined,
    });
  });

  it("negotiates v6 for stable session-owned task cancellation", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("session-1", token, { sessionInboxWireVersion: 6 });
    getHookByTokenMock.mockResolvedValue(hook);
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox(token, { kind: "cancel", tasks: true, turnId: "turn-1" });

    expect(getHookByTokenMock).toHaveBeenCalledWith(token);
    expect(resumeHookMock).toHaveBeenCalledWith(hook, {
      kind: "cancel",
      tasks: true,
      turnId: "turn-1",
      version: 6,
    });
  });

  it.each([
    ["markerless", undefined],
    ["v5", { sessionInboxWireVersion: 5 }],
  ])(
    "rejects stable session-owned task cancellation for a %s consumer before persistence",
    async (_name, metadata) => {
      const token = sessionCommandHookToken("session-1");
      getHookByTokenMock.mockResolvedValue(sessionHook("session-1", token, metadata));

      await expect(resumeSessionInbox(token, { kind: "cancel", tasks: true })).rejects.toThrow(
        /Cannot encode session-owned task cancellation for wire version/,
      );

      expect(getHookByTokenMock).toHaveBeenCalledWith(token);
      expect(resumeHookMock).not.toHaveBeenCalled();
    },
  );

  it("encodes continuation delivery for the resolved consumer and resumes that hook", async () => {
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

  it("inspects reserved session aliases outside the stable inbox", async () => {
    const token = "eve:session:session-1:session-timeout";
    const hook = sessionHook("session-1", token, { sessionInboxWireVersion: 1 });
    getHookByTokenMock.mockResolvedValue(hook);
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox(token, { kind: "session-timeout" });

    expect(getHookByTokenMock).toHaveBeenCalledWith(token);
    expect(resumeHookMock).toHaveBeenCalledWith(hook, {
      kind: "session-timeout",
      version: 1,
    });
  });

  it("retains metadata negotiation when a stable delivery needs the current caller wire", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("session-1", token, { sessionInboxWireVersion: 2 });
    getHookByTokenMock.mockResolvedValue(hook);
    resumeHookMock.mockResolvedValue(hook);

    await resumeSessionInbox(token, {
      caller: {
        activityObserver: { sink: { url: "https://example.com/activity", version: 1 } },
        callId: "call-1",
        replyTo: { kind: "hook", token: "reply-1" },
        subagentName: "researcher",
      },
      kind: "send",
      payload: { message: "follow-up" },
    });

    expect(getHookByTokenMock).toHaveBeenCalledWith(token);
    expect(resumeHookMock).toHaveBeenCalledWith(
      hook,
      expect.objectContaining({
        caller: expect.objectContaining({ activityObserver: expect.any(Object) }),
        version: 2,
      }),
    );
  });
});

function sessionHook(runId: string, token: string, metadata?: unknown) {
  return { metadata, runId, token } as never;
}
