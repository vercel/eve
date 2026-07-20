import { z } from "#compiled/zod/index.js";
import {
  extractCodexAccountIdFromToken,
  isFreshCodexAccessToken,
  readCodexAuthCredentials,
  writeCodexAuthCredentials,
  type CodexAuthCredentials,
  type CodexChatGptCredentials,
  type CodexRefreshedTokens,
} from "./auth.js";
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_AUTH_ISSUER = "https://auth.openai.com";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type Fetch = typeof globalThis.fetch;
type FetchInput = Parameters<Fetch>[0];
type CodexCredentialsWriter = (input: {
  readonly credentials: CodexChatGptCredentials;
  readonly tokens: CodexRefreshedTokens;
}) => Promise<CodexChatGptCredentials>;
type RefreshChatGptCredentialsInput = {
  readonly clientId: string;
  readonly credentials: CodexChatGptCredentials & { readonly refreshToken: string };
  readonly fetch: Fetch;
  readonly issuer: string;
  readonly writeCredentials: CodexCredentialsWriter;
};

export interface CodexTransportOptions {
  readonly clientId?: string;
  readonly codexApiEndpoint?: string;
  readonly fetch?: Fetch;
  readonly issuer?: string;
  readonly now?: () => number;
  readonly readCredentials?: () => Promise<CodexAuthCredentials>;
  readonly writeCredentials?: CodexCredentialsWriter;
}

const codexRefreshResponseSchema = z
  .object({
    access_token: z.string().trim().min(1),
    id_token: z.string().trim().min(1).optional(),
    refresh_token: z.string().trim().min(1),
  })
  .passthrough();

/**
 * AI SDK's OpenAI client gives eve one per-request hook: `fetch`. Codex needs
 * that hook to choose credentials and endpoint per login mode, not just to swap
 * the base URL. API-key logins stay on OpenAI's Responses endpoint; ChatGPT
 * logins use the Codex backend with a refreshed bearer token.
 */
export function createCodexFetch(options: CodexTransportOptions = {}): Fetch {
  const httpFetch = options.fetch ?? fetch;
  const readCredentials = options.readCredentials ?? readCodexAuthCredentials;
  const now = options.now ?? Date.now;
  const writeCredentials = options.writeCredentials ?? createDefaultCodexCredentialsWriter(now);
  const issuer = options.issuer ?? OPENAI_AUTH_ISSUER;
  const clientId = options.clientId ?? OPENAI_CLIENT_ID;
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT;
  let refreshPromise: Promise<CodexChatGptCredentials> | undefined;

  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const credentials = await readCredentials();
    const headers = cloneHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.set("originator", "eve");

    if (credentials.kind === "api-key") {
      headers.set("authorization", `Bearer ${credentials.apiKey}`);
      return httpFetch(input, fetchInit(input, init, headers));
    }

    const chatGptCredentials = await authenticateChatGpt();
    headers.set("authorization", `Bearer ${chatGptCredentials.accessToken}`);
    if (chatGptCredentials.accountId !== undefined) {
      headers.set("ChatGPT-Account-Id", chatGptCredentials.accountId);
    }

    // Response storage (`store: false`, which the Codex backend requires) is
    // injected by createCodexSubscriptionModel's call-options wrapper — the
    // transport only owns credentials and the endpoint rewrite.
    return httpFetch(
      rewriteCodexEndpoint(requestUrl(input), codexApiEndpoint),
      fetchInit(input, init, headers),
    );

    async function authenticateChatGpt(): Promise<
      CodexChatGptCredentials & { readonly accessToken: string }
    > {
      if (credentials.kind !== "chatgpt") {
        throw new Error("Expected ChatGPT Codex credentials.");
      }
      if (
        credentials.accessToken !== undefined &&
        isFreshCodexAccessToken(credentials.accessToken, now())
      ) {
        return { ...credentials, accessToken: credentials.accessToken };
      }
      const refreshToken = credentials.refreshToken;
      if (refreshToken === undefined) {
        throw new Error(
          `Codex ChatGPT login state at ${credentials.authPath} does not include a refresh token. Run \`codex login\` again before using experimental_chatgpt.`,
        );
      }
      if (refreshPromise === undefined) {
        refreshPromise = refreshChatGptCredentials({
          clientId,
          credentials: { ...credentials, refreshToken },
          fetch: httpFetch,
          issuer,
          writeCredentials,
        }).finally(() => {
          refreshPromise = undefined;
        });
      }
      const refreshed = await refreshPromise;
      if (refreshed.accessToken === undefined) {
        throw new Error("Codex token refresh did not return an access token.");
      }
      return { ...refreshed, accessToken: refreshed.accessToken };
    }
  };
}

export function rewriteCodexEndpoint(input: string, codexApiEndpoint = CODEX_API_ENDPOINT): string {
  const url = new URL(input);
  if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) {
    return codexApiEndpoint;
  }
  return input;
}

async function refreshChatGptCredentials(
  input: RefreshChatGptCredentialsInput,
): Promise<CodexChatGptCredentials> {
  const response = await input.fetch(`${input.issuer}/oauth/token`, {
    body: new URLSearchParams({
      client_id: input.clientId,
      grant_type: "refresh_token",
      refresh_token: input.credentials.refreshToken,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `Codex token refresh failed with status ${response.status}. Run \`codex login\` again.`,
    );
  }

  const tokens = parseRefreshResponse(await response.json());
  return input.writeCredentials({
    credentials: input.credentials,
    tokens: {
      ...tokens,
      accountId:
        tokens.accountId ??
        input.credentials.accountId ??
        extractCodexAccountIdFromToken(tokens.idToken) ??
        extractCodexAccountIdFromToken(tokens.accessToken),
    },
  });
}

function parseRefreshResponse(value: unknown): CodexRefreshedTokens {
  const parsed = codexRefreshResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Codex token refresh did not return access_token and refresh_token.");
  }
  const accessToken = parsed.data.access_token;
  const refreshToken = parsed.data.refresh_token;
  const idToken = parsed.data.id_token;

  return {
    accessToken,
    refreshToken,
    ...(idToken !== undefined && { idToken }),
    accountId:
      extractCodexAccountIdFromToken(idToken) ?? extractCodexAccountIdFromToken(accessToken),
  };
}

function createDefaultCodexCredentialsWriter(now: () => number): CodexCredentialsWriter {
  return (input) =>
    writeCodexAuthCredentials({
      ...input,
      now: () => new Date(now()),
    });
}

function cloneHeaders(input: RequestInit["headers"] | undefined): Headers {
  const headers = new Headers(input);
  return headers;
}

function requestUrl(input: FetchInput): string {
  if (input instanceof Request) return input.url;
  return input.toString();
}

function fetchInit(
  input: FetchInput,
  init: RequestInit | undefined,
  headers: Headers,
): RequestInit {
  if (init !== undefined) {
    return { ...init, headers };
  }
  if (input instanceof Request) {
    return {
      body: input.body,
      cache: input.cache,
      credentials: input.credentials,
      headers,
      integrity: input.integrity,
      keepalive: input.keepalive,
      method: input.method,
      mode: input.mode,
      redirect: input.redirect,
      referrer: input.referrer,
      referrerPolicy: input.referrerPolicy,
      signal: input.signal,
    };
  }
  return { headers };
}
