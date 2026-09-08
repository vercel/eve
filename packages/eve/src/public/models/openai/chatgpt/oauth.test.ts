import { describe, expect, it, vi } from "vitest";
import { CHATGPT_CLIENT_ID, requestChatGptTokens } from "./oauth.js";
import { createUnsignedJwt } from "./unsigned-jwt.js";

describe("ChatGPT OAuth token exchange", () => {
  it("exchanges a PKCE code and retains account identity from the ID token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        id_token: createUnsignedJwt({
          email: "alice@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
        }),
      }),
    );
    await expect(
      requestChatGptTokens(
        {
          grant_type: "authorization_code",
          code: "code",
          code_verifier: "verifier",
          redirect_uri: "http://localhost:1455/auth/callback",
        },
        { fetch, now: () => 1000 },
      ),
    ).resolves.toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 3_601_000,
      accountId: "acct-1",
      accountLabel: "alice@example.com",
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("https://auth.openai.com/oauth/token");
    const request = fetch.mock.calls[0]?.[1];
    expect(request?.redirect).toBe("error");
    expect(request?.body).toEqual(
      new URLSearchParams({
        client_id: CHATGPT_CLIENT_ID,
        grant_type: "authorization_code",
        code: "code",
        code_verifier: "verifier",
        redirect_uri: "http://localhost:1455/auth/callback",
      }),
    );
  });

  it("keeps the refresh token when the provider does not rotate it", async () => {
    const previous = {
      accessToken: "old",
      refreshToken: "keep",
      expiresAt: 1,
      accountId: "acct-1",
    };
    await expect(
      requestChatGptTokens(
        { grant_type: "refresh_token", refresh_token: "keep" },
        { previous, fetch: async () => Response.json({ access_token: "new", expires_in: 3600 }) },
      ),
    ).resolves.toMatchObject({ refreshToken: "keep", accountId: "acct-1" });
  });

  it.each([{}, { access_token: "access" }, { access_token: "", refresh_token: "refresh" }])(
    "rejects incomplete credentials",
    async (body) => {
      await expect(
        requestChatGptTokens({}, { fetch: async () => Response.json(body) }),
      ).rejects.toThrow("usable session");
    },
  );

  it("does not expose response bodies or network errors", async () => {
    for (const fetch of [
      async () => new Response("secret", { status: 500 }),
      async () => {
        throw new Error("secret");
      },
    ]) {
      const error = await requestChatGptTokens({}, { fetch }).catch((value: unknown) => value);
      expect(String(error)).not.toContain("secret");
    }
  });

  it.each(["secret-token", "x".repeat(65 * 1024)])(
    "rejects malformed or oversized responses without disclosing them",
    async (body) => {
      await expect(
        requestChatGptTokens({}, { fetch: async () => new Response(body) }),
      ).rejects.toThrow("invalid response");
    },
  );

  it("preserves caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      requestChatGptTokens(
        {},
        {
          signal: controller.signal,
          fetch: async () => {
            throw new Error("aborted");
          },
        },
      ),
    ).rejects.toThrow("cancelled");
  });
});
