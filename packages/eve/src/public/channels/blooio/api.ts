/**
 * Minimal Blooio v2 REST API wrapper used by the Blooio channel.
 *
 * Requests use JSON bodies and Bearer authentication. No Blooio SDK
 * dependency is required or exposed through eve public APIs. See
 * https://backend.blooio.com/v2/api.
 */

/** Default base URL for the Blooio v2 API. */
export const DEFAULT_BLOOIO_BASE_URL = "https://backend.blooio.com/v2/api";

/** API key, materialized directly or from an async secret provider. */
export type BlooioApiKey = string | (() => string | Promise<string>);

/** Webhook signing secret, materialized directly or from an async secret provider. */
export type BlooioWebhookSecret = string | (() => string | Promise<string>);

/** Fetch implementation override matching the global `fetch` signature. Defaults to the runtime global; supply a custom one for tests or non-standard runtimes. */
export type BlooioFetch = typeof fetch;

/** Credentials required for Blooio REST API calls and webhook verification. */
export interface BlooioCredentials {
  /** Blooio API key (Bearer token). Falls back to `BLOOIO_API_KEY`. */
  readonly apiKey?: BlooioApiKey;
  /** Webhook signing secret (`whsec_...`). Falls back to `BLOOIO_WEBHOOK_SECRET`. */
  readonly webhookSecret?: BlooioWebhookSecret;
}

/** Shared Blooio REST API options. */
export interface BlooioApiOptions {
  readonly credentials?: BlooioCredentials;
  /** Override the API base URL. Falls back to `BLOOIO_BASE_URL`, then the public default. */
  readonly baseUrl?: string;
  readonly fetch?: BlooioFetch;
}

/**
 * Result of a Blooio REST call: HTTP `status`, an `ok` flag, and `body`.
 * `body` holds parsed JSON for a JSON response, the raw text string
 * otherwise, or `null` when empty.
 */
export interface BlooioApiResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

/** iMessage send-with-effect identifiers. iMessage-only; ignored on SMS/RCS. */
export type BlooioMessageEffect =
  | "balloons"
  | "celebration"
  | "confetti"
  | "echo"
  | "fireworks"
  | "gentle"
  | "invisible-ink"
  | "lasers"
  | "loud"
  | "love"
  | "slam"
  | "spotlight";

/** One outbound attachment: a public URL with an optional display name. */
export interface BlooioAttachment {
  readonly url: string;
  readonly name?: string;
}

/** Parameters for sending an outbound Blooio message. */
export interface BlooioSendMessageInput extends BlooioApiOptions {
  /** Conversation target: phone (E.164), email, group ID (`grp_...`), or comma-separated recipients. */
  readonly chatId: string;
  readonly text?: string;
  readonly attachments?: readonly (string | BlooioAttachment)[];
  /** E.164 number to send from. Must be assigned to your API key. Optional for Twilio keys. */
  readonly fromNumber?: string;
  readonly effect?: BlooioMessageEffect;
  /** Send as an inline reply to an earlier Blooio message (`msg_...`). iMessage-only. */
  readonly replyToMessageId?: string;
  readonly shareContact?: boolean;
  readonly useTypingIndicator?: boolean;
  /** Unique key to prevent duplicate sends. Re-using a key returns the original result. */
  readonly idempotencyKey?: string;
}

/** Parameters for adding or removing a reaction on a message. */
export interface BlooioReactInput extends BlooioApiOptions {
  readonly chatId: string;
  /** Message ID (`msg_...`) or a relative index (`-1` for the last message). */
  readonly messageId: string;
  /** Prefix with `+` to add or `-` to remove. Tapbacks: love, like, dislike, laugh, emphasize, question. Emoji also accepted. */
  readonly reaction: string;
  /** Only used when `messageId` is a relative index: filters which direction the index counts. */
  readonly direction?: "inbound" | "outbound";
}

/** Filters for listing messages in a conversation. */
export interface BlooioListMessagesInput extends BlooioApiOptions {
  readonly chatId: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly direction?: "inbound" | "outbound";
  readonly since?: number;
  readonly until?: number;
  readonly sort?: "asc" | "desc";
}

/**
 * Builds the Blooio channel-local continuation token
 * (`<internalId>:<chatId>`). Route `send()` namespaces this with the
 * channel name before passing it to the runtime
 * (`blooio:<internalId>:<chatId>`), keeping a conversation sticky to a
 * specific phone line. `internalId` may be empty for proactive sessions
 * that do not yet know the sending number.
 */
export function blooioContinuationToken(internalId: string | undefined, chatId: string): string {
  return `${internalId ?? ""}:${chatId}`;
}

/** Resolves a Blooio API key, falling back to `BLOOIO_API_KEY`. */
export async function resolveBlooioApiKey(apiKey?: BlooioApiKey): Promise<string> {
  const source = apiKey ?? process.env.BLOOIO_API_KEY;
  if (!source) throw new Error("blooioChannel: BLOOIO_API_KEY is required.");
  return typeof source === "function" ? await source() : source;
}

/** Resolves the API base URL, falling back to `BLOOIO_BASE_URL` then the public default. */
export function resolveBlooioBaseUrl(baseUrl?: string): string {
  const resolved = baseUrl ?? process.env.BLOOIO_BASE_URL ?? DEFAULT_BLOOIO_BASE_URL;
  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

/**
 * Calls the Blooio v2 REST API with Bearer auth and an optional JSON body.
 *
 * `path` is relative to the resolved base URL and must begin with `/`.
 */
export async function callBlooioApi(
  input: BlooioApiOptions & {
    readonly method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
    readonly path: string;
    readonly body?: unknown;
    readonly query?: Readonly<Record<string, string | number | boolean | undefined | null>>;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<BlooioApiResponse> {
  const apiKey = await resolveBlooioApiKey(input.credentials?.apiKey);
  const apiFetch = input.fetch ?? fetch;
  const base = resolveBlooioBaseUrl(input.baseUrl);
  const url = new URL(`${base}${input.path}`);
  if (input.query) {
    for (const [key, value] of Object.entries(input.query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    ...input.headers,
  };
  let body: string | undefined;
  if (input.body !== undefined && input.method !== "GET") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(input.body);
  }

  const response = await apiFetch(url.toString(), {
    method: input.method,
    headers,
    body,
  });
  return {
    status: response.status,
    ok: response.ok,
    body: await parseResponseBody(response),
  };
}

/** Sends a text and/or attachment message to a chat (`POST /chats/{chatId}/messages`). */
export async function sendBlooioMessage(input: BlooioSendMessageInput): Promise<BlooioApiResponse> {
  if (!input.text && (!input.attachments || input.attachments.length === 0)) {
    throw new Error("blooioChannel: sending a message requires text or at least one attachment.");
  }
  const body: Record<string, unknown> = {};
  if (input.text) body.text = input.text;
  if (input.attachments && input.attachments.length > 0) {
    body.attachments = input.attachments.map((attachment) =>
      typeof attachment === "string"
        ? attachment
        : attachment.name
          ? { url: attachment.url, name: attachment.name }
          : attachment.url,
    );
  }
  if (input.fromNumber) body.from_number = input.fromNumber;
  if (input.effect) body.effect = input.effect;
  if (input.replyToMessageId) body.reply_to = { message_id: input.replyToMessageId };
  if (input.shareContact !== undefined) body.share_contact = input.shareContact;
  if (input.useTypingIndicator !== undefined) body.use_typing_indicator = input.useTypingIndicator;

  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/messages`,
    body,
    headers: input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
  });
}

/** Adds or removes a tapback/emoji reaction on a message. */
export async function reactBlooioMessage(input: BlooioReactInput): Promise<BlooioApiResponse> {
  const body: Record<string, unknown> = { reaction: input.reaction };
  if (input.direction) body.direction = input.direction;
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/messages/${encodeURIComponent(
      input.messageId,
    )}/reactions`,
    body,
  });
}

/** Shows the typing indicator in a chat (`POST /chats/{chatId}/typing`). iMessage-only. */
export async function startBlooioTyping(
  input: BlooioApiOptions & { readonly chatId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/typing`,
  });
}

/** Hides the typing indicator in a chat (`DELETE /chats/{chatId}/typing`). */
export async function stopBlooioTyping(
  input: BlooioApiOptions & { readonly chatId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "DELETE",
    path: `/chats/${encodeURIComponent(input.chatId)}/typing`,
  });
}

/** Marks a chat as read and sends a read receipt (`POST /chats/{chatId}/read`). */
export async function markBlooioChatRead(
  input: BlooioApiOptions & { readonly chatId: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "POST",
    path: `/chats/${encodeURIComponent(input.chatId)}/read`,
  });
}

/** Checks whether a contact supports iMessage, SMS, and/or FaceTime. */
export async function checkBlooioCapabilities(
  input: BlooioApiOptions & { readonly contact: string },
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "GET",
    path: `/contacts/${encodeURIComponent(input.contact)}/capabilities`,
  });
}

/** Lists messages in a conversation with optional filters. */
export async function listBlooioMessages(
  input: BlooioListMessagesInput,
): Promise<BlooioApiResponse> {
  return callBlooioApi({
    baseUrl: input.baseUrl,
    credentials: input.credentials,
    fetch: input.fetch,
    method: "GET",
    path: `/chats/${encodeURIComponent(input.chatId)}/messages`,
    query: {
      direction: input.direction,
      limit: input.limit,
      offset: input.offset,
      since: input.since,
      sort: input.sort,
      until: input.until,
    },
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
