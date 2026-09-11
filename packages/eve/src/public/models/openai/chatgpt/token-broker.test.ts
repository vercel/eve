import { describe, expect, it, vi } from "vitest";

import type { ChatGptCredentialStore } from "./credential-store.js";
import type { ChatGptCredentials, ChatGptRefreshCredentials } from "./oauth.js";
import { createCodexTokenBroker } from "./token-broker.js";

const credentials: ChatGptCredentials = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 2_000_000_000_000,
  accountId: "acct-1",
  accountLabel: "alice@example.com",
};

function memoryStore(
  initial: ChatGptCredentials | ChatGptRefreshCredentials | undefined = credentials,
): ChatGptCredentialStore {
  let value = initial;
  return {
    read: vi.fn(async () => value),
    update: vi.fn<ChatGptCredentialStore["update"]>(async (callback) => {
      const next = await callback(value);
      value = next;
      return next;
    }),
  };
}

function refreshed() {
  return Response.json({
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
  });
}

describe("ChatGPT token broker", () => {
  it("caches an eve session without spawning Codex", async () => {
    const store = memoryStore();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const broker = createCodexTokenBroker({ store, fetch, now: () => 1_800_000_000_000 });
    await expect(broker.getToken({ reason: "request" })).resolves.toEqual({
      token: credentials.accessToken,
      expiresAt: credentials.expiresAt,
      accountId: "acct-1",
      accountLabel: "alice@example.com",
    });
    await broker.getToken({ reason: "request" });
    expect(store.read).toHaveBeenCalledOnce();
    await expect(broker.refreshState()).resolves.toMatchObject({ kind: "ready" });
    expect(fetch).not.toHaveBeenCalled();
    expect(broker.state()).toEqual({ kind: "ready", accountLabel: "alice@example.com" });
  });

  it("exchanges a saved refresh token on a cold start and caches the access token", async () => {
    const store = memoryStore({ refreshToken: "saved-refresh", accountId: "acct-1" });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => refreshed());
    const broker = createCodexTokenBroker({ store, fetch });
    await expect(broker.getToken({ reason: "request" })).resolves.toMatchObject({
      token: "new-access",
      accountId: "acct-1",
    });
    expect(fetch.mock.calls[0]?.[1]?.body?.toString()).toContain("refresh_token=saved-refresh");
    await broker.getToken({ reason: "request" });
    await broker.refreshState();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reads the latest saved refresh token after acquiring the update lock", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => refreshed());
    const broker = createCodexTokenBroker({
      fetch,
      store: {
        read: async () => ({ refreshToken: "previous-refresh" }),
        update: async (callback) => callback({ refreshToken: "rotated-by-other-process" }),
      },
    });
    await expect(broker.getToken({ reason: "request" })).resolves.toMatchObject({
      token: "new-access",
    });
    expect(fetch.mock.calls[0]?.[1]?.body?.toString()).toContain(
      "refresh_token=rotated-by-other-process",
    );
  });

  it("refreshes within five minutes of expiry and persists rotated credentials", async () => {
    const store = memoryStore({ ...credentials, expiresAt: 1_800_000_100_000 });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => refreshed());
    const broker = createCodexTokenBroker({ store, fetch, now: () => 1_800_000_000_000 });
    await expect(broker.getToken({ reason: "request" })).resolves.toMatchObject({
      token: "new-access",
    });
    expect(fetch.mock.calls[0]?.[1]?.body?.toString()).toContain("refresh_token=refresh-token");
    await expect(store.read()).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
  });

  it("coalesces concurrent rejected-token refreshes", async () => {
    const gate = Promise.withResolvers<Response>();
    const fetch = vi.fn<typeof globalThis.fetch>(() => gate.promise);
    const broker = createCodexTokenBroker({ store: memoryStore(), fetch });
    const first = broker.getToken({ reason: "rejected" });
    const second = broker.getToken({ reason: "rejected" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    gate.resolve(refreshed());
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reuses credentials another eve process refreshed while acquiring the lock", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const broker = createCodexTokenBroker({
      fetch,
      store: {
        read: async () => credentials,
        update: async (callback) => callback({ ...credentials, accessToken: "other-process" }),
      },
    });
    await expect(broker.getToken({ reason: "rejected" })).resolves.toMatchObject({
      token: "other-process",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forces a refresh after an ordinary resolution already in flight", async () => {
    const gate = Promise.withResolvers<ChatGptCredentials>();
    const store = memoryStore();
    vi.mocked(store.read).mockReturnValueOnce(gate.promise);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => refreshed());
    const broker = createCodexTokenBroker({ store, fetch });
    const first = broker.getToken({ reason: "request" });
    const second = broker.getToken({ reason: "rejected" });
    gate.resolve(credentials);
    await expect(first).resolves.toMatchObject({ token: "access-token" });
    await expect(second).resolves.toMatchObject({ token: "new-access" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports signed out and discovers a subsequent eve login", async () => {
    const store = memoryStore();
    vi.mocked(store.read).mockResolvedValueOnce(undefined);
    const broker = createCodexTokenBroker({ store });
    await expect(broker.getToken({ reason: "request" })).rejects.toThrow("/model");
    expect(broker.state()).toEqual({ kind: "signed-out" });
    await expect(broker.refreshState()).resolves.toEqual({
      kind: "ready",
      accountLabel: "alice@example.com",
    });
  });

  it("preserves the sign-in hint when credentials disappear before a rejected request retries", async () => {
    const store = memoryStore();
    vi.mocked(store.read).mockResolvedValue(undefined);
    const broker = createCodexTokenBroker({ store });
    await expect(broker.getToken({ reason: "rejected" })).rejects.toThrow("/model");
    expect(broker.state()).toEqual({ kind: "reauth-required" });
  });

  it("reports revoked credentials without exposing the provider response", async () => {
    const broker = createCodexTokenBroker({
      store: memoryStore(),
      fetch: async () => new Response("secret-bearer-token", { status: 401 }),
    });
    await expect(broker.getToken({ reason: "rejected" })).rejects.toThrow("/model");
    expect(broker.state()).toEqual({ kind: "reauth-required" });
  });

  it("keeps credentials after a temporary provider failure and recovers", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("secret", { status: 503 }))
      .mockResolvedValueOnce(refreshed());
    const store = memoryStore({ ...credentials, expiresAt: 1 });
    const broker = createCodexTokenBroker({ store, fetch });
    await expect(broker.getToken({ reason: "request" })).rejects.toThrow("HTTP 503");
    expect(broker.state()).toMatchObject({ kind: "unavailable" });
    expect(JSON.stringify(broker.state())).not.toContain("secret");
    await expect(store.read()).resolves.toMatchObject({ refreshToken: "refresh-token" });
    await expect(broker.refreshState()).resolves.toMatchObject({ kind: "ready" });
  });
});
