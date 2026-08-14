import { describe, expect, it, vi } from "vitest";

import type { CodexAppServer } from "./codex-app-server.js";
import { createCodexTokenBroker } from "./token-broker.js";
import { createUnsignedJwt } from "./unsigned-jwt.js";

describe("Codex token broker", () => {
  it("caches a fresh ChatGPT token", async () => {
    const token = createUnsignedJwt({
      exp: 2_000_000_000,
      chatgpt_account_id: "acct-1",
      sub: "samlp|profile|person@example.com",
    });
    const getAuthStatus = vi.fn(async () => ({ authMethod: "chatgpt", authToken: token }));
    const broker = createCodexTokenBroker({
      appServer: { getAuthStatus },
      now: () => 1_800_000_000_000,
    });

    await expect(broker.getToken({ reason: "request" })).resolves.toMatchObject({
      accountId: "acct-1",
      accountLabel: "person@example.com",
      token,
    });
    await broker.getToken({ reason: "request" });

    expect(getAuthStatus).toHaveBeenCalledOnce();
    expect(broker.state()).toMatchObject({
      kind: "ready",
      accountId: "acct-1",
      accountLabel: "person@example.com",
    });
  });

  it("asks Codex to refresh a token within five minutes of expiry", async () => {
    const stale = createUnsignedJwt({ exp: 1_800_000_100 });
    const fresh = createUnsignedJwt({ exp: 2_000_000_000 });
    const getAuthStatus = vi
      .fn<CodexAppServer["getAuthStatus"]>()
      .mockResolvedValueOnce({ authMethod: "chatgpt", authToken: stale })
      .mockResolvedValueOnce({ authMethod: "chatgpt", authToken: fresh });
    const broker = createCodexTokenBroker({
      appServer: { getAuthStatus },
      now: () => 1_800_000_000_000,
    });

    await expect(broker.getToken({ reason: "request" })).resolves.toMatchObject({ token: fresh });
    expect(getAuthStatus).toHaveBeenNthCalledWith(1, { refreshToken: false });
    expect(getAuthStatus).toHaveBeenNthCalledWith(2, { refreshToken: true });
  });

  it("coalesces concurrent forced refreshes", async () => {
    const token = createUnsignedJwt({ exp: 2_000_000_000 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getAuthStatus = vi.fn(async () => {
      await gate;
      return { authMethod: "chatgpt", authToken: token };
    });
    const broker = createCodexTokenBroker({ appServer: { getAuthStatus } });

    const first = broker.getToken({ reason: "rejected" });
    const second = broker.getToken({ reason: "rejected" });
    await vi.waitFor(() => expect(getAuthStatus).toHaveBeenCalledOnce());
    release?.();
    await Promise.all([first, second]);

    expect(getAuthStatus).toHaveBeenCalledWith({ refreshToken: true });
  });

  it("forces a refresh after an ordinary resolution is already in flight", async () => {
    const rejected = createUnsignedJwt({ exp: 2_000_000_000, sub: "rejected" });
    const refreshed = createUnsignedJwt({ exp: 2_000_000_000, sub: "refreshed" });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getAuthStatus = vi
      .fn<CodexAppServer["getAuthStatus"]>()
      .mockImplementationOnce(async () => {
        await gate;
        return { authMethod: "chatgpt", authToken: rejected };
      })
      .mockResolvedValueOnce({ authMethod: "chatgpt", authToken: refreshed });
    const broker = createCodexTokenBroker({ appServer: { getAuthStatus } });

    const request = broker.getToken({ reason: "request" });
    await vi.waitFor(() => expect(getAuthStatus).toHaveBeenCalledOnce());
    const retry = broker.getToken({ reason: "rejected" });
    release?.();

    await expect(request).resolves.toMatchObject({ token: rejected });
    await expect(retry).resolves.toMatchObject({ token: refreshed });
    expect(getAuthStatus).toHaveBeenNthCalledWith(1, { refreshToken: false });
    expect(getAuthStatus).toHaveBeenNthCalledWith(2, { refreshToken: true });
  });

  it("reports signed out when Codex has no ChatGPT token", async () => {
    const broker = createCodexTokenBroker({
      appServer: { getAuthStatus: async () => ({ requiresOpenaiAuth: true }) },
    });

    await expect(broker.getToken({ reason: "request" })).rejects.toThrow("codex login");
    expect(broker.state()).toEqual({ kind: "signed-out" });
  });

  it("reports reauthentication after a rejected token cannot refresh", async () => {
    const broker = createCodexTokenBroker({
      appServer: { getAuthStatus: async () => ({ authMethod: "chatgpt" }) },
    });

    await expect(broker.getToken({ reason: "rejected" })).rejects.toThrow("codex login");
    expect(broker.state()).toEqual({ kind: "reauth-required" });
  });

  it("restarts Codex before probing a repaired signed-out session", async () => {
    const token = createUnsignedJwt({ exp: 2_000_000_000 });
    const restart = vi.fn();
    const getAuthStatus = vi
      .fn<CodexAppServer["getAuthStatus"]>()
      .mockResolvedValueOnce({ requiresOpenaiAuth: true })
      .mockResolvedValueOnce({ authMethod: "chatgpt", authToken: token });
    const broker = createCodexTokenBroker({ appServer: { getAuthStatus, restart } });

    await broker.getToken({ reason: "request" }).catch(() => undefined);
    await expect(broker.refreshState()).resolves.toMatchObject({ kind: "ready" });

    expect(restart).toHaveBeenCalledOnce();
  });

  it("reports an unavailable app-server without including token material", async () => {
    const secret = "secret-bearer-token";
    const broker = createCodexTokenBroker({
      appServer: {
        getAuthStatus: async () => {
          throw new Error("Codex app-server exited");
        },
      },
    });

    const error = await broker.getToken({ reason: "request" }).catch((value: unknown) => value);
    expect(String(error)).not.toContain(secret);
    expect(broker.state()).toMatchObject({ kind: "unavailable" });
  });
});
