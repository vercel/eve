import { readDevelopmentModelCredential } from "#internal/model-auth/development-broker-client.js";
import { isObject } from "#shared/guards.js";
import { getDefaultCodexTokenBroker, type CodexTokenBroker } from "./token-broker.js";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

type Fetch = typeof globalThis.fetch;
type FetchInput = Parameters<Fetch>[0];

export interface CodexTransportOptions {
  readonly broker?: CodexTokenBroker;
  readonly codexApiEndpoint?: string;
  readonly fetch?: Fetch;
}

/**
 * Routes OpenAI Responses requests through the Codex backend. Authentication is
 * resolved through Codex app-server when available, with eve-owned credentials
 * used only when the Codex binary is not installed.
 */
export function createCodexFetch(options: CodexTransportOptions = {}): Fetch {
  const httpFetch = options.fetch ?? fetch;
  const resolveToken = async (rejectedToken?: string, signal?: AbortSignal | null) => {
    const reason = rejectedToken === undefined ? "request" : "rejected";
    if (options.broker) return options.broker.getToken({ reason });
    return (
      (await readDevelopmentModelCredential("chatgpt", rejectedToken, signal)) ??
      (await getDefaultCodexTokenBroker().getToken({ reason }))
    );
  };
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT;

  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = rewriteCodexEndpoint(requestUrl(input), codexApiEndpoint);
    const request = prepareCodexBody(init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const token = await resolveToken(undefined, signal);
    const first = await httpFetch(url, authenticatedInit(input, request, token));
    if (first.status !== 401 || !isReplayable(input, init)) return first;

    await first.body?.cancel();
    const refreshed = await resolveToken(token.token, signal);
    return httpFetch(url, authenticatedInit(input, request, refreshed));
  };
}

interface CodexRequest {
  readonly init: RequestInit | undefined;
  readonly promptCacheKey?: string;
}

function prepareCodexBody(init: RequestInit | undefined): CodexRequest {
  if (typeof init?.body !== "string") return { init };

  let body: unknown;
  try {
    body = JSON.parse(init.body);
  } catch {
    return { init };
  }
  if (!isObject(body)) return { init };
  const promptCacheKey =
    typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined;
  if (!Array.isArray(body.input)) return { init, promptCacheKey };

  // Only response item IDs are forbidden; tool call IDs and IDs inside tool
  // inputs or outputs belong to the conversation and must survive replay.
  let changed = false;
  for (const item of body.input) {
    if (isObject(item) && "id" in item) {
      delete item.id;
      changed = true;
    }
  }
  return { init: changed ? { ...init, body: JSON.stringify(body) } : init, promptCacheKey };
}

export function rewriteCodexEndpoint(input: string, codexApiEndpoint = CODEX_API_ENDPOINT): string {
  const url = new URL(input);
  if (url.pathname.includes("/v1/responses") || url.pathname.includes("/chat/completions")) {
    return codexApiEndpoint;
  }
  return input;
}

function authenticatedInit(
  input: FetchInput,
  { init, promptCacheKey }: CodexRequest,
  token: { readonly accountId?: string; readonly token: string },
): RequestInit {
  const headers = cloneHeaders(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  // The Codex backend routes prompt-cache affinity on `session-id`, not on the body's
  // `prompt_cache_key`; the Codex CLI sends the same value in both.
  if (promptCacheKey !== undefined && !headers.has("session-id")) {
    headers.set("session-id", promptCacheKey);
  }
  headers.delete("authorization");
  headers.delete("Authorization");
  headers.set("authorization", `Bearer ${token.token}`);
  headers.set("originator", "eve");
  if (token.accountId !== undefined) headers.set("ChatGPT-Account-Id", token.accountId);
  else headers.delete("ChatGPT-Account-Id");
  return fetchInit(input, init, headers);
}

function isReplayable(input: FetchInput, init: RequestInit | undefined): boolean {
  if (input instanceof Request) return false;
  return !(init?.body instanceof ReadableStream);
}

function cloneHeaders(input: RequestInit["headers"] | undefined): Headers {
  return new Headers(input);
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
  if (init !== undefined) return { ...init, headers };
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
