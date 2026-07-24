import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { forwardSessionCallbackNotification } from "#execution/session-callback-notification.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

const CALLBACK = {
  callId: "call-1",
  subagentName: "research",
  token: "tok123",
  url: "https://caller.example.com/eve/v1/callback/tok123",
};

const AUTHORIZATION_REQUIRED_EVENT = {
  data: {
    authorization: { url: "https://idp.example.com/authorize" },
    description: "Linear workspace access",
    name: "linear",
    sequence: 3,
    stepIndex: 1,
    turnId: "turn-1",
  },
  type: "authorization.required",
} satisfies HandleMessageStreamEvent;

describe("forwardSessionCallbackNotification", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    warnSpy.mockRestore();
  });

  it("posts an authorization event as a notification callback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await forwardSessionCallbackNotification({
      ctx: createContext(),
      event: AUTHORIZATION_REQUIRED_EVENT,
    });

    expect(fetchMock).toHaveBeenCalledWith("https://caller.example.com/eve/v1/callback/tok123", {
      body: JSON.stringify({
        callId: "call-1",
        event: { ...AUTHORIZATION_REQUIRED_EVENT, status: "notification" },
        sessionId: "remote-session",
        subagentName: "research",
      }),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it("forwards authorization.completed events", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await forwardSessionCallbackNotification({
      ctx: createContext(),
      event: {
        data: {
          name: "linear",
          outcome: "authorized",
          sequence: 4,
          stepIndex: 1,
          turnId: "turn-1",
        },
        type: "authorization.completed",
      },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as { body: string } | undefined;
    const body = JSON.parse(init?.body ?? "{}") as {
      event: { status: string; type: string };
    };
    expect(body.event).toMatchObject({ status: "notification", type: "authorization.completed" });
  });

  it("does nothing for sessions without callback metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "remote-session");

    await forwardSessionCallbackNotification({ ctx, event: AUTHORIZATION_REQUIRED_EVENT });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["message.appended", "session.completed", "input.requested"] as const)(
    "does nothing for %s events",
    async (type) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await forwardSessionCallbackNotification({
        ctx: createContext(),
        event: { type } as HandleMessageStreamEvent,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("skips and warns on invalid callback metadata without throwing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const ctx = new ContextContainer();
    ctx.set(SessionIdKey, "remote-session");
    ctx.set(SessionCallbackKey, {
      ...CALLBACK,
      url: "http://169.254.169.254/eve/v1/callback/tok123",
    });

    await forwardSessionCallbackNotification({ ctx, event: AUTHORIZATION_REQUIRED_EVENT });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("swallows and logs delivery failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await expect(
      forwardSessionCallbackNotification({
        ctx: createContext(),
        event: AUTHORIZATION_REQUIRED_EVENT,
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("swallows and logs network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(
      forwardSessionCallbackNotification({
        ctx: createContext(),
        event: AUTHORIZATION_REQUIRED_EVENT,
      }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});

function createContext(): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, "remote-session");
  ctx.set(SessionCallbackKey, CALLBACK);
  return ctx;
}
