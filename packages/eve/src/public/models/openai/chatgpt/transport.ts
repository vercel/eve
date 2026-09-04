import { getDefaultCodexTokenBroker, type CodexTokenBroker } from "./token-broker.js";
import { isObject } from "#shared/guards.js";

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
 * resolved by the Codex CLI; eve never reads, refreshes, or persists OAuth
 * credentials itself.
 */
export function createCodexFetch(options: CodexTransportOptions = {}): Fetch {
  const httpFetch = options.fetch ?? fetch;
  const broker = options.broker ?? getDefaultCodexTokenBroker();
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT;

  return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = rewriteCodexEndpoint(requestUrl(input), codexApiEndpoint);
    const token = await broker.getToken({ reason: "request" });
    const first = await httpFetch(url, authenticatedInit(input, init, token));
    if (first.status !== 401 || !isReplayable(input, init)) return first;

    await first.body?.cancel();
    const refreshed = await broker.getToken({ reason: "rejected" });
    return httpFetch(url, authenticatedInit(input, init, refreshed));
  };
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
  init: RequestInit | undefined,
  token: { readonly accountId?: string; readonly token: string },
): RequestInit {
  const headers = cloneHeaders(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.delete("authorization");
  headers.delete("Authorization");
  headers.set("authorization", `Bearer ${token.token}`);
  headers.set("originator", "eve");
  if (token.accountId !== undefined) headers.set("ChatGPT-Account-Id", token.accountId);
  else headers.delete("ChatGPT-Account-Id");
  const resolved = fetchInit(input, init, headers);
  const body = withoutResponseItemIds(resolved.body);
  if (body === resolved.body) return resolved;
  headers.delete("content-length");
  return { ...resolved, body, headers };
}

function withoutResponseItemIds(body: RequestInit["body"]): RequestInit["body"] {
  if (typeof body !== "string") return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!isObject(parsed) || !Array.isArray(parsed.input)) return body;

  let changed = false;
  const input = parsed.input.map((item) => {
    if (!isObject(item) || !("id" in item)) return item;
    const { id: _id, ...rest } = item;
    changed = true;
    return rest;
  });
  return changed ? JSON.stringify({ ...parsed, input }) : body;
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
