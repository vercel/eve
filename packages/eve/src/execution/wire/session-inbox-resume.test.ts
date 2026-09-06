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
  it.each(SESSION_INBOX_WIRE_VERSIONS)(
    "uses the persisted consumer version %i without reading hook metadata",
    async (version) => {
      await resumeSessionInbox(
        { sessionId: "child-session", version },
        { kind: "send", payload: { inputResponses: [{ requestId: "req-1", text: "yes" }] } },
      );

      expect(getHookByTokenMock).not.toHaveBeenCalled();
      expect(getRawHookByTokenMock).not.toHaveBeenCalled();
      expect(resumeHookMock).toHaveBeenCalledWith(
        sessionCommandHookToken("child-session"),
        expect.objectContaining({ kind: "deliver", version }),
      );
    },
  );

  it("rejects unsupported saved consumer versions before resuming", async () => {
    await expect(
      resumeSessionInbox({ sessionId: "child-session", version: 99 }, { kind: "clear" }),
    ).rejects.toThrow(/unsupported wire version 99/);
    expect(getHookByTokenMock).not.toHaveBeenCalled();
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("keeps version-sensitive cancellation checks when using a saved address", async () => {
    await expect(
      resumeSessionInbox(
        { sessionId: "child-session", version: 5 },
        { kind: "cancel", tasks: true },
      ),
    ).rejects.toThrow(/Cannot encode session-owned task cancellation/);
    expect(resumeHookMock).not.toHaveBeenCalled();
  });

  it("uses the advertised version even for an ordinary stable-inbox message", async () => {
    const token = sessionCommandHookToken("session-1");
    const hook = sessionHook("session-1", token, { sessionInboxWireVersion: 2 });
    getHookByTokenMock.mockResolvedValue(hook);

    await resumeSessionInbox(token, { kind: "send", payload: { message: "follow-up" } });

    expect(getHookByTokenMock).toHaveBeenCalledWith(token);
    expect(resumeHookMock).toHaveBeenCalledWith(
      hook,
      expect.objectContaining({
        kind: "deliver",
        payloads: [{ message: "follow-up" }],
        version: 2,
      }),
    );
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

  describe.each(["stable", "continuation", "saved address"])("%s task delivery", (addressKind) => {
    const command = {
      kind: "send" as const,
      payload: {
        task: {
          agentRequests: [
            {
              taskId: "task-1",
              replyTo: "agent-reply",
              request: {
                kind: "agent-invoke" as const,
                invocationId: "call-1",
                input: { message: "Find it", target: "research" },
              },
            },
          ],
        },
      },
    };

    function address(version: number | undefined) {
      const token =
        addressKind === "continuation" ? "continuation-1" : sessionCommandHookToken("session-1");
      getHookByTokenMock.mockResolvedValue(
        sessionHook(
          "session-1",
          token,
          version === undefined ? undefined : { sessionInboxWireVersion: version },
        ),
      );
      getRawHookByTokenMock.mockRejectedValue(new HookNotFoundError(token));
      return addressKind === "saved address"
        ? { sessionId: "session-1", version: version ?? 0 }
        : token;
    }

    it.each([undefined, 1, 2, 3, 99])(
      "rejects unsupported version %s before delivery",
      async (version) => {
        await expect(resumeSessionInbox(address(version), command)).rejects.toThrow(
          /Session inbox|wire version/,
        );
        expect(resumeHookMock).not.toHaveBeenCalled();
      },
    );

    it.each([1, 2, 3, 4, 5, 6])(
      "rejects an unknown task operation for version %i",
      async (version) => {
        await expect(
          resumeSessionInbox(address(version), {
            kind: "send",
            payload: { task: { futureOperation: {} } },
          } as never),
        ).rejects.toThrow(/wire version/);
        expect(resumeHookMock).not.toHaveBeenCalled();
      },
    );

    it.each([4, 5, 6])("delivers agent requests using supported version %i", async (version) => {
      await resumeSessionInbox(address(version), command);
      expect(resumeHookMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ version, payloads: [command.payload] }),
      );
    });
  });

  it.each(["stable", "continuation"])(
    "keeps ordinary messages working for a markerless %s inbox",
    async (kind) => {
      const token = kind === "stable" ? sessionCommandHookToken("session-1") : "continuation-1";
      const hook = sessionHook("session-1", token);
      getHookByTokenMock.mockResolvedValue(hook);
      getRawHookByTokenMock.mockRejectedValue(new HookNotFoundError(token));

      await resumeSessionInbox(token, { kind: "send", payload: { message: "hello" } });

      expect(resumeHookMock).toHaveBeenCalledWith(
        hook,
        expect.objectContaining(
          kind === "stable"
            ? { kind: "send", payload: { message: "hello" } }
            : { kind: "deliver", payloads: [{ message: "hello" }] },
        ),
      );
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

  it("encodes caller activity for the advertised version", async () => {
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
