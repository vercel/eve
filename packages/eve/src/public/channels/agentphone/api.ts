/**
 * Minimal AgentPhone REST API wrapper used by the AgentPhone channel.
 *
 * Requests use JSON encoding and Bearer-token auth. No AgentPhone SDK
 * dependency is required or exposed through eve public APIs.
 */

/** API key, materialized directly or from an async secret provider. */
export type AgentPhoneApiKey = string | (() => string | Promise<string>);

/** Fetch implementation override. Defaults to the runtime global. */
export type AgentPhoneFetch = typeof fetch;

/** Credentials required for AgentPhone REST API calls. */
export interface AgentPhoneCredentials {
  readonly apiKey?: AgentPhoneApiKey;
}

/** Shared AgentPhone REST API options. */
export interface AgentPhoneApiOptions {
  readonly credentials?: AgentPhoneCredentials;
  readonly apiBaseUrl?: string;
  readonly fetch?: AgentPhoneFetch;
}

/** Result of an AgentPhone REST call. */
export interface AgentPhoneApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/** Parameters for creating an outbound AgentPhone message. */
export interface AgentPhoneSendMessageInput extends AgentPhoneApiOptions {
  readonly toNumber: string;
  readonly body: string;
  readonly fromNumber?: string;
  readonly numberId?: string;
  readonly agentId?: string;
  readonly mediaUrls?: readonly string[];
}

/** Parameters for creating an outbound AgentPhone call. */
export interface AgentPhoneMakeCallInput extends AgentPhoneApiOptions {
  readonly agentId: string;
  readonly toNumber: string;
  readonly fromNumberId?: string;
  readonly initialGreeting?: string;
  readonly voice?: string;
  readonly systemPrompt?: string;
}

/**
 * Builds the AgentPhone channel-local continuation token (`<from>:<to>`).
 * Route `send()` namespaces this with the channel name before passing it
 * to the runtime.
 */
export function agentphoneContinuationToken(from: string, to: string | undefined): string {
  return `${from}:${to ?? ""}`;
}

/** Resolves an AgentPhone API key, falling back to `AGENTPHONE_API_KEY`. */
export async function resolveAgentPhoneApiKey(apiKey?: AgentPhoneApiKey): Promise<string> {
  const source = apiKey ?? process.env.AGENTPHONE_API_KEY;
  if (!source) throw new Error("AGENTPHONE_API_KEY is required.");
  return typeof source === "function" ? await source() : source;
}

/** Calls AgentPhone's REST API with Bearer auth and a JSON body. */
export async function callAgentPhoneApi(input: {
  readonly credentials?: AgentPhoneCredentials;
  readonly apiBaseUrl?: string;
  readonly fetch?: AgentPhoneFetch;
  readonly method?: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}): Promise<AgentPhoneApiResponse> {
  const apiKey = await resolveAgentPhoneApiKey(input.credentials?.apiKey);
  const apiFetch = input.fetch ?? fetch;
  const url = `${input.apiBaseUrl ?? "https://api.agentphone.ai"}${input.path}`;
  const response = await apiFetch(url, {
    method: input.method ?? "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: input.body ? JSON.stringify(input.body) : undefined,
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await parseResponseBody(response),
  };
}

/** Sends an outbound message via AgentPhone's Messages resource. */
export async function sendAgentPhoneMessage(
  input: AgentPhoneSendMessageInput,
): Promise<AgentPhoneApiResponse> {
  const body: Record<string, unknown> = {
    to_number: input.toNumber,
    body: input.body,
  };
  if (input.fromNumber) body.from_number = input.fromNumber;
  if (input.numberId) body.number_id = input.numberId;
  if (input.agentId) body.agent_id = input.agentId;
  if (input.mediaUrls?.length) body.media_urls = input.mediaUrls;
  return callAgentPhoneApi({
    apiBaseUrl: input.apiBaseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    path: "/v1/messages",
    body,
  });
}

/** Initiates an outbound call via AgentPhone's Calls resource. */
export async function makeAgentPhoneCall(
  input: AgentPhoneMakeCallInput,
): Promise<AgentPhoneApiResponse> {
  const body: Record<string, unknown> = {
    agentId: input.agentId,
    toNumber: input.toNumber,
  };
  if (input.fromNumberId) body.fromNumberId = input.fromNumberId;
  if (input.initialGreeting) body.initialGreeting = input.initialGreeting;
  if (input.voice) body.voice = input.voice;
  if (input.systemPrompt) body.systemPrompt = input.systemPrompt;
  return callAgentPhoneApi({
    apiBaseUrl: input.apiBaseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    path: "/v1/calls",
    body,
  });
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
