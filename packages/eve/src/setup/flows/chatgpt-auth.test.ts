import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatGptCredentialStore } from "#public/models/openai/chatgpt/credential-store.js";
import type { ChatGptCredentials } from "#public/models/openai/chatgpt/oauth.js";
import { createCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";

vi.mock("node:timers/promises", () => ({
  setTimeout: (ms: number, _value: unknown, options: { signal: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        options.signal.removeEventListener("abort", abort);
        resolve();
      }, ms);
      const abort = (): void => {
        clearTimeout(timer);
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort();
    }),
}));

afterEach(() => vi.useRealTimers());

function setup() {
  let credentials: ChatGptCredentials | undefined;
  const store: ChatGptCredentialStore = {
    read: async () => credentials,
    update: vi.fn<ChatGptCredentialStore["update"]>(async (callback) => {
      credentials = await callback(credentials);
      return credentials;
    }),
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  return {
    store,
    fetch,
    broker: createCodexTokenBroker({ store, fetch }),
    open: vi.fn(),
    log: vi.fn(),
    headless: true,
  };
}

const device = { device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: "1" };

describe("ChatGPT device sign-in", () => {
  it("completes a first sign-in after pending polls without any Codex credentials", async () => {
    vi.useFakeTimers();
    const options = setup();
    options.fetch
      .mockResolvedValueOnce(Response.json(device))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ authorization_code: "code", code_verifier: "verifier" }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      );
    const login = ensureChatGptAuth(options);
    await vi.advanceTimersByTimeAsync(6001);
    await login;
    expect(options.open).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
    expect(options.log.mock.calls[0]?.[0]).toContain("ABCD-EFGH");
    expect(options.fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ device_auth_id: "device-id", user_code: "ABCD-EFGH" }),
    );
    const parameters = options.fetch.mock.calls[4]?.[1]?.body as URLSearchParams;
    expect(parameters.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
    expect(parameters.get("code_verifier")).toBe("verifier");
    await expect(options.store.read()).resolves.toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
    });
  });

  it("explains disabled device authorization without exposing provider content", async () => {
    const options = setup();
    options.fetch.mockResolvedValueOnce(new Response("secret", { status: 403 }));
    await expect(ensureChatGptAuth(options)).rejects.toThrow("Settings > Security");
    expect(options.store.update).not.toHaveBeenCalled();
  });

  it("bounds pending device sign-in to five minutes", async () => {
    vi.useFakeTimers();
    const options = setup();
    options.fetch
      .mockResolvedValueOnce(Response.json(device))
      .mockResolvedValue(new Response(null, { status: 404 }));
    const result = ensureChatGptAuth(options).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(String(await result)).toContain("timed out");
    expect(options.store.update).not.toHaveBeenCalled();
  });

  it("cancels polling without storing a partial session", async () => {
    vi.useFakeTimers();
    const options = setup();
    options.fetch.mockResolvedValueOnce(Response.json(device));
    const controller = new AbortController();
    const result = ensureChatGptAuth({ ...options, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("cancelled"));
    expect(String(await result)).toContain("cancelled");
    expect(options.store.update).not.toHaveBeenCalled();
  });

  it("reuses an existing eve login without opening a browser", async () => {
    const options = setup();
    await options.store.update(async () => ({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: Date.now() + 3600_000,
    }));
    await ensureChatGptAuth(options);
    expect(options.open).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
  });
});
