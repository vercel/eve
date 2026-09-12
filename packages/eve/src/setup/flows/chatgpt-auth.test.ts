import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexBinaryNotFoundError,
  type CodexAppServer,
} from "#public/models/openai/chatgpt/codex-app-server.js";
import {
  ChatGptInvalidStoredSessionError,
  type ChatGptCredentialStore,
} from "#public/models/openai/chatgpt/credential-store.js";
import {
  ChatGptSignInRequiredError,
  type ChatGptCredentials,
} from "#public/models/openai/chatgpt/oauth.js";
import { ChatGptSignedOutError } from "#public/models/openai/chatgpt/token.js";
import {
  createCodexTokenBroker,
  type CodexTokenBroker,
} from "#public/models/openai/chatgpt/token-broker.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
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

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(spawn).mockReset();
});

function setup() {
  let credentials: ChatGptCredentials | undefined;
  const store: ChatGptCredentialStore = {
    read: async () => credentials,
    resolveToken: vi.fn(async ({ forceRefresh }) => {
      if (!credentials) {
        if (forceRefresh) throw new ChatGptSignInRequiredError();
        throw new ChatGptSignedOutError();
      }
      return {
        token: credentials.accessToken,
        expiresAt: credentials.expiresAt,
        ...(credentials.accountId && { accountId: credentials.accountId }),
        ...(credentials.accountLabel && { accountLabel: credentials.accountLabel }),
      };
    }),
    update: vi.fn<ChatGptCredentialStore["update"]>(async (callback) => {
      credentials = await callback(credentials);
      return credentials;
    }),
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  return {
    store,
    fetch,
    broker: createCodexTokenBroker({ appServer: missingCodexAppServer(), store, fetch }),
    open: vi.fn(),
    log: vi.fn(),
    headless: true,
  };
}

function missingCodexAppServer(): CodexAppServer {
  return {
    resolveToken: vi.fn(async () => {
      throw new CodexBinaryNotFoundError();
    }),
  };
}

const device = { device_auth_id: "device-id", user_code: "ABCD-EFGH", interval: "1" };

describe("ChatGPT device sign-in", () => {
  it("reports unavailable secure storage before opening OAuth", async () => {
    const options = setup();
    vi.spyOn(options.store, "read").mockRejectedValue(new Error("OS secret store is locked"));
    await expect(ensureChatGptAuth(options)).rejects.toThrow("OS secret store is locked");
    expect(options.open).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
    expect(options.store.update).not.toHaveBeenCalled();
  });

  it("checks secure storage even after the broker was previously signed out", async () => {
    const options = setup();
    await expect(options.broker.refreshState()).resolves.toEqual({ kind: "signed-out" });
    vi.spyOn(options.store, "read").mockRejectedValue(new Error("OS secret store is locked"));
    await expect(ensureChatGptAuth(options)).rejects.toThrow("OS secret store is locked");
    expect(options.open).not.toHaveBeenCalled();
    expect(options.fetch).not.toHaveBeenCalled();
  });

  it("allows a new sign-in to replace malformed secure credentials", async () => {
    vi.useFakeTimers();
    const options = setup();
    vi.spyOn(options.store, "read")
      .mockRejectedValueOnce(new ChatGptInvalidStoredSessionError())
      .mockRejectedValueOnce(new ChatGptInvalidStoredSessionError());
    options.fetch
      .mockResolvedValueOnce(Response.json(device))
      .mockResolvedValueOnce(
        Response.json({ authorization_code: "code", code_verifier: "verifier" }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      );
    const login = ensureChatGptAuth(options);
    await vi.advanceTimersByTimeAsync(2001);
    await login;
    expect(options.store.update).toHaveBeenCalledWith(expect.any(Function), { replace: true });
  });

  it("uses Codex login when app-server owns the credentials", async () => {
    const options = setup();
    let signedIn = false;
    const restart = vi.fn();
    const appServer: CodexAppServer = {
      restart,
      resolveToken: vi.fn(async () => {
        if (!signedIn) throw new ChatGptSignedOutError();
        return { token: "codex-token" };
      }),
    };
    const broker = createCodexTokenBroker({ appServer, store: options.store });
    const codexLogin = vi.fn(async () => {
      signedIn = true;
    });

    await ensureChatGptAuth({ ...options, broker, codexLogin });

    expect(codexLogin).toHaveBeenCalledOnce();
    expect(restart).toHaveBeenCalledOnce();
    expect(options.store.update).not.toHaveBeenCalled();
    expect(options.open).not.toHaveBeenCalled();
    expect(broker.credentialOwner()).toBe("codex");
  });

  it("pipes Codex login output through the parent logger", async () => {
    const options = setup();
    let signedIn = false;
    const restart = vi.fn();
    const appServer: CodexAppServer = {
      restart,
      resolveToken: vi.fn(async () => {
        if (!signedIn) throw new ChatGptSignedOutError();
        return { token: "codex-token" };
      }),
    };
    const broker = createCodexTokenBroker({ appServer, store: options.store });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr });
    vi.mocked(spawn).mockReturnValue(child as never);

    const login = ensureChatGptAuth({ ...options, broker });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    stdout.write("Starting local login server.\nOpen the browser");
    stderr.write("Waiting for authentication.\n");
    signedIn = true;
    child.emit("close", 0, null);
    await login;

    expect(spawn).toHaveBeenCalledWith("codex", ["login"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(options.log).toHaveBeenCalledWith("Starting local login server.");
    expect(options.log).toHaveBeenCalledWith("Waiting for authentication.");
    expect(options.log).toHaveBeenCalledWith("Open the browser");
    expect(restart).toHaveBeenCalledOnce();
  });

  it("does not fall back when app-server fails for a reason other than a missing binary", async () => {
    const options = setup();
    const codexLogin = vi.fn();
    const broker = createCodexTokenBroker({
      appServer: {
        resolveToken: vi.fn(async () => {
          throw new Error("Codex protocol failed");
        }),
      },
      store: options.store,
    });

    await expect(ensureChatGptAuth({ ...options, broker, codexLogin })).rejects.toThrow(
      "Codex protocol failed",
    );
    expect(codexLogin).not.toHaveBeenCalled();
    expect(options.store.update).not.toHaveBeenCalled();
  });

  it("does not enter eve-owned sign-in with an unresolved credential owner", async () => {
    const options = setup();
    const broker: CodexTokenBroker = {
      credentialOwner: () => undefined,
      getToken: vi.fn(),
      refreshState: vi.fn(async () => ({ kind: "signed-out" }) as const),
      state: () => ({ kind: "signed-out" }),
    };

    await expect(ensureChatGptAuth({ ...options, broker })).rejects.toThrow(
      "ChatGPT credential owner could not be resolved",
    );
    expect(options.store.update).not.toHaveBeenCalled();
    expect(options.open).not.toHaveBeenCalled();
  });

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

  it("does not save a login cancelled while waiting for the credential lock", async () => {
    vi.useFakeTimers();
    const options = setup();
    options.fetch
      .mockResolvedValueOnce(Response.json(device))
      .mockResolvedValueOnce(
        Response.json({ authorization_code: "code", code_verifier: "verifier" }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      );
    const lock = Promise.withResolvers<void>();
    const save = vi.fn();
    vi.mocked(options.store.update).mockImplementationOnce(async (callback) => {
      await lock.promise;
      const credentials = await callback(undefined);
      save(credentials);
      return credentials;
    });
    const controller = new AbortController();
    const result = ensureChatGptAuth({ ...options, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2001);
    expect(options.store.update).toHaveBeenCalledOnce();
    controller.abort(new Error("cancelled while waiting"));
    lock.resolve();
    expect(String(await result)).toContain("cancelled while waiting");
    expect(save).not.toHaveBeenCalled();
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
