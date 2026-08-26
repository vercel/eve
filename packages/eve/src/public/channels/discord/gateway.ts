import { createHmac, timingSafeEqual } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";
import type { DiscordContext } from "#public/channels/discord/discordChannel.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export interface DiscordGatewayEnvelopeV1 {
  readonly version: 1;
  readonly connectorId: string;
  readonly deliveryId: string;
  readonly event: "MESSAGE_CREATE";
  readonly sequence: number | null;
  readonly sessionId?: string;
  readonly data: unknown;
}

export interface DiscordMessage {
  readonly id: string;
  readonly channelId: string;
  readonly guildId?: string;
  readonly threadId?: string;
  readonly content: string;
  readonly author: { readonly id: string; readonly isBot: boolean; readonly username?: string };
  readonly mentions: readonly { readonly id: string }[];
  readonly referencedMessage?: {
    readonly authorId?: string;
    readonly authorIsBot?: boolean;
    readonly id?: string;
  };
  readonly attachments: readonly {
    readonly filename?: string;
    readonly id: string;
    readonly url?: string;
  }[];
  readonly raw: JsonObject;
}

export interface DiscordGatewayConfig {
  readonly connectorId: string;
  readonly route?: string;
  readonly secret: string | (() => string | Promise<string>);
  onMessage?(
    ctx: DiscordContext,
    message: DiscordMessage,
  ): DiscordGatewayMessageResult | Promise<DiscordGatewayMessageResult>;
}

export type DiscordGatewayMessageResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly title?: string;
} | null;

interface DiscordGatewayVerificationConfig {
  readonly connectorId: string;
  readonly secret: string | (() => string | Promise<string>);
}

export async function verifyDiscordGatewayRequest(
  request: Request,
  config: DiscordGatewayVerificationConfig,
): Promise<{ body: string; envelope: DiscordGatewayEnvelopeV1 }> {
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 1_000_000) {
    throw new DiscordGatewayRequestError(413, "body_too_large");
  }

  const timestamp = request.headers.get("x-eve-discord-timestamp") ?? "";
  const connectorId = request.headers.get("x-eve-discord-connector") ?? "";
  const signature = request.headers.get("x-eve-discord-signature") ?? "";
  if (!/^\d+$/.test(timestamp) || !connectorId || !/^v1=[0-9a-f]{64}$/.test(signature)) {
    throw new DiscordGatewayRequestError(401, "invalid_signature_headers");
  }
  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300
  ) {
    throw new DiscordGatewayRequestError(401, "stale_signature");
  }
  if (connectorId !== config.connectorId) {
    throw new DiscordGatewayRequestError(401, "connector_mismatch");
  }

  const secret = typeof config.secret === "function" ? await config.secret() : config.secret;
  if (!secret) throw new DiscordGatewayRequestError(401, "missing_secret");
  const expected = createHmac("sha256", secret)
    .update(`v1\n${timestamp}\n${connectorId}\n${body}`, "utf8")
    .digest();
  const received = Buffer.from(signature.slice(3), "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new DiscordGatewayRequestError(401, "signature_mismatch");
  }

  let envelope: DiscordGatewayEnvelopeV1;
  try {
    envelope = parseEnvelope(JSON.parse(body));
  } catch {
    throw new DiscordGatewayRequestError(400, "invalid_envelope");
  }
  if (envelope.connectorId !== config.connectorId) {
    throw new DiscordGatewayRequestError(401, "connector_mismatch");
  }
  return { body, envelope };
}

export class DiscordGatewayRequestError extends Error {
  readonly status: number;
  readonly reason: string;

  constructor(status: number, reason: string) {
    super(`discordChannel: Gateway request rejected: ${reason}.`);
    this.status = status;
    this.reason = reason;
  }
}

export function parseDiscordGatewayMessage(value: unknown): DiscordMessage | null {
  if (!isObject(value)) return null;
  const raw = value as Record<string, unknown>;
  const author = isObject(raw.author) ? (raw.author as Record<string, unknown>) : undefined;
  if (
    !isNonEmptyString(raw.id) ||
    !isNonEmptyString(raw.channel_id) ||
    !author ||
    !isNonEmptyString(author.id)
  ) {
    return null;
  }
  const referenced = isObject(raw.referenced_message)
    ? (raw.referenced_message as Record<string, unknown>)
    : undefined;
  const referencedAuthor = isObject(referenced?.author)
    ? (referenced.author as Record<string, unknown>)
    : undefined;
  const thread = isObject(raw.thread) ? (raw.thread as Record<string, unknown>) : undefined;
  return {
    id: raw.id,
    channelId: raw.channel_id,
    guildId: isNonEmptyString(raw.guild_id) ? raw.guild_id : undefined,
    threadId: isNonEmptyString(thread?.id) ? thread.id : undefined,
    content: typeof raw.content === "string" ? raw.content : "",
    author: {
      id: author.id,
      isBot: author.bot === true,
      username: isNonEmptyString(author.username) ? author.username : undefined,
    },
    mentions: parseIds(raw.mentions),
    referencedMessage:
      referencedAuthor === undefined
        ? undefined
        : {
            authorId: isNonEmptyString(referencedAuthor.id) ? referencedAuthor.id : undefined,
            authorIsBot: referencedAuthor.bot === true,
            id: readReferencedMessageId(raw.message_reference),
          },
    attachments: parseAttachments(raw.attachments),
    raw: parseJsonObject(raw),
  };
}

function readReferencedMessageId(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const reference = value as Record<string, unknown>;
  return isNonEmptyString(reference.message_id) ? reference.message_id : undefined;
}

function parseEnvelope(value: unknown): DiscordGatewayEnvelopeV1 {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    !isNonEmptyString(value.connectorId) ||
    !isNonEmptyString(value.deliveryId) ||
    value.event !== "MESSAGE_CREATE" ||
    (value.sequence !== null && typeof value.sequence !== "number")
  ) {
    throw new Error("invalid envelope");
  }
  return {
    version: 1,
    connectorId: value.connectorId,
    deliveryId: value.deliveryId,
    event: "MESSAGE_CREATE",
    sequence: value.sequence,
    sessionId: isNonEmptyString(value.sessionId) ? value.sessionId : undefined,
    data: value.data,
  };
}

function parseIds(value: unknown): readonly { readonly id: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isObject(entry) || !isNonEmptyString((entry as Record<string, unknown>).id)) return [];
    return [{ id: (entry as Record<string, unknown>).id as string }];
  });
}

function parseAttachments(
  value: unknown,
): readonly { readonly filename?: string; readonly id: string; readonly url?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const attachment = entry as Record<string, unknown>;
    if (!isNonEmptyString(attachment.id)) return [];
    return [
      {
        id: attachment.id,
        filename: isNonEmptyString(attachment.filename) ? attachment.filename : undefined,
        url: isNonEmptyString(attachment.url) ? attachment.url : undefined,
      },
    ];
  });
}
