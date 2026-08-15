import { describe, expect, it, vi } from "vitest";

import type {
  CodexAuthCredentials,
  CodexChatGptCredentials,
  CodexRefreshedTokens,
} from "./auth.js";
import { createCodexFetch, rewriteCodexEndpoint } from "./transport.js";
import { createUnsignedJwt } from "./unsigned-jwt.js";

const CODEX_ENDPOINT = "https://chatgpt.test/backend-api/codex/responses";
const ISSUER = "https://auth.test";

describe("Codex direct transport", () => {
  it("rewrites OAuth Responses requests to the Codex backend with refreshed ChatGPT auth", async () => {
    const refreshedAccessToken = createUnsignedJwt({
      exp: 2_000_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-new" },
    });
    const requests: RecordedRequest[] = [];
    const httpFetch = createRecordingFetch(requests, async (url) => {
      if (url === `${ISSUER}/oauth/token`) {
        return Response.json({
          access_token: refreshedAccessToken,
          id_token: createUnsignedJwt({ chatgpt_account_id: "acct-new" }),
          refresh_token: "refresh-new",
        });
      }
      return Response.json({ ok: true });
    });
    const writeCredentials = vi.fn(
      async (input: {
        readonly credentials: CodexChatGptCredentials;
        readonly tokens: CodexRefreshedTokens;
      }): Promise<CodexChatGptCredentials> => ({
        kind: "chatgpt",
        accessToken: input.tokens.accessToken,
        accountId: input.tokens.accountId,
        authPath: input.credentials.authPath,
        codexHome: input.credentials.codexHome,
        refreshToken: input.tokens.refreshToken,
      }),
    );
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: httpFetch,
      issuer: ISSUER,
      now: () => 1_800_000_000_000,
      readCredentials: async () => ({
        kind: "chatgpt",
        accessToken: createUnsignedJwt({ exp: 1 }),
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
        refreshToken: "refresh-old",
      }),
      writeCredentials,
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      body: '{"stream":true}',
      headers: {
        authorization: "Bearer placeholder",
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(`${ISSUER}/oauth/token`);
    expect(requests[0]?.body).toContain("grant_type=refresh_token");
    expect(requests[0]?.body).toContain("refresh_token=refresh-old");
    expect(writeCredentials).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ refreshToken: "refresh-old" }),
      tokens: expect.objectContaining({
        accessToken: refreshedAccessToken,
        accountId: "acct-new",
        refreshToken: "refresh-new",
      }),
    });
    expect(requests[1]).toMatchObject({
      method: "POST",
      url: CODEX_ENDPOINT,
    });
    expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({ stream: true });
    expect(requests[1]?.headers.get("authorization")).toBe(`Bearer ${refreshedAccessToken}`);
    expect(requests[1]?.headers.get("ChatGPT-Account-Id")).toBe("acct-new");
    expect(requests[1]?.headers.get("originator")).toBe("eve");
    expect(requests[1]?.headers.get("content-type")).toBe("application/json");
  });

  it("leaves API-key auth on the OpenAI API endpoint", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      fetch: createRecordingFetch(requests),
      readCredentials: async (): Promise<CodexAuthCredentials> => ({
        kind: "api-key",
        apiKey: "sk-test",
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
      }),
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      headers: { authorization: "Bearer placeholder" },
      method: "POST",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer sk-test");
    expect(requests[0]?.headers.has("ChatGPT-Account-Id")).toBe(false);
    expect(requests[0]?.headers.get("originator")).toBe("eve");
  });

  it("leaves API-key request bodies unchanged", async () => {
    const requests: RecordedRequest[] = [];
    const codexFetch = createCodexFetch({
      fetch: createRecordingFetch(requests),
      readCredentials: async (): Promise<CodexAuthCredentials> => ({
        kind: "api-key",
        apiKey: "sk-test",
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
      }),
    });

    await codexFetch("https://api.openai.com/v1/responses", {
      body: '{"model":"gpt-5.2-codex","input":[],"store":true}',
      method: "POST",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toBe('{"model":"gpt-5.2-codex","input":[],"store":true}');
  });

  it("deduplicates concurrent ChatGPT token refreshes", async () => {
    const requests: RecordedRequest[] = [];
    let releaseRefresh: (() => void) | undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const httpFetch = createRecordingFetch(requests, async (url) => {
      if (url === `${ISSUER}/oauth/token`) {
        await refreshGate;
        return Response.json({
          access_token: createUnsignedJwt({ exp: 2_000_000_000 }),
          refresh_token: "refresh-new",
        });
      }
      return Response.json({ ok: true });
    });
    const writeCredentials = vi.fn(
      async (input: {
        readonly credentials: CodexChatGptCredentials;
        readonly tokens: CodexRefreshedTokens;
      }): Promise<CodexChatGptCredentials> => ({
        ...input.credentials,
        accessToken: input.tokens.accessToken,
        refreshToken: input.tokens.refreshToken,
      }),
    );
    const codexFetch = createCodexFetch({
      codexApiEndpoint: CODEX_ENDPOINT,
      fetch: httpFetch,
      issuer: ISSUER,
      now: () => 1_800_000_000_000,
      readCredentials: async () => ({
        kind: "chatgpt",
        authPath: "/home/user/.codex/auth.json",
        codexHome: "/home/user/.codex",
        refreshToken: "refresh-old",
      }),
      writeCredentials,
    });

    const first = codexFetch("https://api.openai.com/v1/responses");
    const second = codexFetch("https://api.openai.com/v1/responses");
    await vi.waitFor(() =>
      expect(requests.filter((request) => request.url === `${ISSUER}/oauth/token`)).toHaveLength(1),
    );
    releaseRefresh?.();
    await Promise.all([first, second]);

    expect(requests.filter((request) => request.url === `${ISSUER}/oauth/token`)).toHaveLength(1);
    expect(writeCredentials).toHaveBeenCalledOnce();
    expect(requests.filter((request) => request.url === CODEX_ENDPOINT)).toHaveLength(2);
  });

  it("matches OpenCode's OAuth URL rewrite boundary", () => {
    expect(rewriteCodexEndpoint("https://api.openai.com/v1/responses", CODEX_ENDPOINT)).toBe(
      CODEX_ENDPOINT,
    );
    expect(rewriteCodexEndpoint("https://api.openai.com/chat/completions", CODEX_ENDPOINT)).toBe(
      CODEX_ENDPOINT,
    );
    expect(rewriteCodexEndpoint("https://api.openai.com/v1/models", CODEX_ENDPOINT)).toBe(
      "https://api.openai.com/v1/models",
    );
  });
});

interface RecordedRequest {
  readonly body: string | undefined;
  readonly headers: Headers;
  readonly method: string | undefined;
  readonly url: string;
}

function createRecordingFetch(
  requests: RecordedRequest[],
  responseForUrl: (url: string) => Response | Promise<Response> = () => Response.json({ ok: true }),
): typeof fetch {
  return async (input, init) => {
    requests.push({
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: new Headers(init?.headers),
      method: init?.method,
      url: input instanceof Request ? input.url : input.toString(),
    });
    return responseForUrl(requests[requests.length - 1]!.url);
  };
}
