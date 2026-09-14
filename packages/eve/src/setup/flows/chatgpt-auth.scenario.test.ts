import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCodexTokenBroker } from "#public/models/openai/chatgpt/token-broker.js";
import type { ChatGptCredentialStore } from "#public/models/openai/chatgpt/credential-store.js";
import {
  CodexBinaryNotFoundError,
  type CodexAppServer,
} from "#public/models/openai/chatgpt/codex-app-server.js";
import {
  ChatGptSignInRequiredError,
  type ChatGptCredentials,
} from "#public/models/openai/chatgpt/oauth.js";
import { ChatGptSignedOutError } from "#public/models/openai/chatgpt/token.js";
import { ensureChatGptAuth } from "./chatgpt-auth.js";

const controllers: AbortController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
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
      return { token: credentials.accessToken, expiresAt: credentials.expiresAt };
    }),
    update: vi.fn<ChatGptCredentialStore["update"]>(async (callback) => {
      credentials = await callback(credentials);
      return credentials;
    }),
  };
  const controller = new AbortController();
  controllers.push(controller);
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
  );
  return {
    store,
    controller,
    fetch,
    broker: createCodexTokenBroker({ appServer: missingCodexAppServer(), store, fetch }),
    log: vi.fn(),
    headless: false,
  };
}

function missingCodexAppServer(): CodexAppServer {
  return {
    resolveToken: vi.fn(async () => {
      throw new CodexBinaryNotFoundError();
    }),
  };
}

describe("native ChatGPT browser login", () => {
  it("signs in from an empty eve session with PKCE and ignores unrelated callbacks", async () => {
    const options = setup();
    let state: string | null = null;
    let challenge: string | null = null;
    let browser: Promise<void> | undefined;
    const login = ensureChatGptAuth({
      ...options,
      signal: options.controller.signal,
      open: (url) => {
        browser = (async () => {
          const auth = new URL(url);
          state = auth.searchParams.get("state");
          challenge = auth.searchParams.get("code_challenge");
          expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
          expect(state?.length).toBeGreaterThanOrEqual(32);
          const wrong = await globalThis.fetch(
            "http://127.0.0.1:1455/auth/callback?state=wrong&error=denied",
          );
          expect(wrong.status).toBe(400);
          const valid = await globalThis.fetch(
            `http://127.0.0.1:1455/auth/callback?state=${state}&code=authorization-code`,
          );
          expect(valid.status).toBe(200);
        })();
      },
    });
    await login;
    await browser;
    const body = options.fetch.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    const parameters = body as URLSearchParams;
    expect(parameters.get("code")).toBe("authorization-code");
    expect(
      createHash("sha256")
        .update(parameters.get("code_verifier") ?? "")
        .digest("base64url"),
    ).toBe(challenge);
    await expect(options.store.read()).resolves.toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
    });
    expect(options.log).toHaveBeenLastCalledWith("ChatGPT subscription connected.");
    expect(options.log.mock.calls.flat().join("\n")).not.toContain("refresh");
  });

  it("cancels the listener without storing credentials, allowing the next login", async () => {
    const options = setup();
    await expect(
      ensureChatGptAuth({
        ...options,
        signal: options.controller.signal,
        open: () => options.controller.abort(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(options.store.update).not.toHaveBeenCalled();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(1455, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a declined sign-in without leaking the provider error", async () => {
    const options = setup();
    let browser: Promise<Response> | undefined;
    await expect(
      ensureChatGptAuth({
        ...options,
        open: (url) => {
          const state = new URL(url).searchParams.get("state");
          browser = globalThis.fetch(
            `http://127.0.0.1:1455/auth/callback?state=${state}&error=denied&error_description=secret`,
          );
        },
      }),
    ).rejects.toThrow("declined");
    await browser;
    expect(options.store.update).not.toHaveBeenCalled();
    expect(options.log.mock.calls.flat().join("\n")).not.toContain("secret");
  });
  it("preserves the cancellation reason while a real device timer is pending", async () => {
    const options = setup();
    options.fetch.mockResolvedValueOnce(
      Response.json({ device_auth_id: "device", user_code: "ABCD-EFGH", interval: "30" }),
    );
    const login = ensureChatGptAuth({
      ...options,
      headless: true,
      signal: options.controller.signal,
      open: () => {
        setTimeout(() => options.controller.abort(new Error("device sign-in cancelled")), 10);
      },
    });
    await expect(login).rejects.toThrow("device sign-in cancelled");
    expect(options.store.update).not.toHaveBeenCalled();
  });
});
