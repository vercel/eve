import { afterEach, describe, expect, it, vi } from "vitest";

import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { SESSION_INBOX_WIRE_VERSION } from "#execution/wire/session-inbox-contract.js";
import { resumeSessionInbox } from "#execution/wire/session-inbox-resume.js";
import { sessionInboxWire } from "#execution/wire/session-inbox-wire.js";

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

describe("resumeSessionInbox", () => {
  it.each([sessionCommandHookToken("session-1"), "continuation-1", "authorization-1"])(
    "resumes %s by token without a capability lookup",
    async (token) => {
      const hook = { runId: "session-1", token };
      resumeHookMock.mockResolvedValue(hook);

      await expect(
        resumeSessionInbox(token, {
          kind: "send",
          payload: { message: "follow-up" },
        }),
      ).resolves.toBe(hook);

      expect(getHookByTokenMock).not.toHaveBeenCalled();
      expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
        token,
        expect.objectContaining({
          kind: "deliver",
          payload: { message: "follow-up" },
          payloads: [{ message: "follow-up" }],
          version: SESSION_INBOX_WIRE_VERSION,
        }),
      );
    },
  );

  it("preserves session-owned task cancellation without negotiation", async () => {
    const token = sessionCommandHookToken("session-1");
    await resumeSessionInbox(token, { kind: "cancel", tasks: true, turnId: "turn-1" });

    expect(getHookByTokenMock).not.toHaveBeenCalled();
    const [resumedToken, wire] = resumeHookMock.mock.calls[0]!;
    expect(resumedToken).toBe(token);
    expect(wire).toMatchObject({ version: SESSION_INBOX_WIRE_VERSION });
    expect(sessionInboxWire.decode(wire)).toMatchObject({
      kind: "cancel",
      tasks: true,
      turnId: "turn-1",
    });
  });

  it("preserves activity observers and delivery routing without negotiation", async () => {
    const token = sessionCommandHookToken("session-1");
    const caller = {
      activityObserver: { sink: { url: "https://example.com/activity", version: 1 as const } },
      callId: "call-1",
      replyTo: { kind: "hook" as const, token: "reply-1" },
      subagentName: "researcher",
    };
    const delivery = {
      acceptedDeploymentId: "dpl_current",
      channelKind: "channel:http" as const,
      channelName: "http",
      deliveryId: "delivery-1",
    };

    await resumeSessionInbox(token, {
      caller,
      delivery,
      kind: "send",
      payload: { message: "follow-up" },
      turnPolicy: "queue",
    });

    expect(getHookByTokenMock).not.toHaveBeenCalled();
    const [resumedToken, wire] = resumeHookMock.mock.calls[0]!;
    expect(resumedToken).toBe(token);
    expect(sessionInboxWire.decode(wire)).toMatchObject({
      caller,
      deliveryMetadata: [{ ...delivery, payloadIndex: 0 }],
      kind: "deliver",
      payloads: [{ message: "follow-up" }],
      turnPolicy: "queue",
    });
  });

  it.each(["clear", "compact", "reset", "session-timeout"] as const)(
    "sends %s in the current wire format",
    async (kind) => {
      await resumeSessionInbox("continuation-1", { kind });
      expect(getHookByTokenMock).not.toHaveBeenCalled();
      expect(resumeHookMock).toHaveBeenCalledExactlyOnceWith(
        "continuation-1",
        expect.objectContaining({ kind, version: SESSION_INBOX_WIRE_VERSION }),
      );
    },
  );

  it("rejects invalid payloads before touching Workflow", async () => {
    await expect(
      resumeSessionInbox("continuation-1", {
        kind: "send",
        payload: { message: 42 as never },
      }),
    ).rejects.toThrow(/does not match wire version/);
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("propagates a missing hook without a compatibility retry", async () => {
    const error = new HookNotFoundError("continuation-1");
    resumeHookMock.mockRejectedValue(error);
    await expect(resumeSessionInbox("continuation-1", { kind: "clear" })).rejects.toBe(error);
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).toHaveBeenCalledOnce();
  });
});
