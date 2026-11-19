import {
  DISCORD_EPHEMERAL_MESSAGE_FLAG,
  DISCORD_INTERACTION_RESPONSE_TYPE,
} from "#public/channels/discord/inbound.js";
import { isNonEmptyString, isObject } from "#shared/guards.js";
import { parseJsonObject } from "#shared/json.js";

export function discordDeferredJson(ephemeral: boolean): Response {
  const body: Record<string, unknown> = {
    type: DISCORD_INTERACTION_RESPONSE_TYPE.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
  };
  if (ephemeral) {
    body.data = { flags: DISCORD_EPHEMERAL_MESSAGE_FLAG };
  }
  return discordJsonBody(body);
}

export function discordJson(
  input: { readonly content: string; readonly ephemeral?: boolean } | Record<string, unknown>,
): Response {
  if ("content" in input && typeof input.content === "string") {
    const data: Record<string, unknown> = {
      allowed_mentions: { parse: [] },
      content: input.content,
    };
    if (input.ephemeral === true) data.flags = DISCORD_EPHEMERAL_MESSAGE_FLAG;
    return discordJsonBody({
      data,
      type: DISCORD_INTERACTION_RESPONSE_TYPE.CHANNEL_MESSAGE_WITH_SOURCE,
    });
  }
  return discordJsonBody(input);
}

export function discordJsonBody(body: Record<string, unknown>): Response {
  return Response.json(parseJsonObject(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function readMessageContent(raw: Record<string, unknown>): string | undefined {
  const message = isObject(raw.message) ? raw.message : null;
  return isNonEmptyString(message?.content) ? message.content : undefined;
}
