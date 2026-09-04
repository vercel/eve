import {
  splitDiscordMessageContent,
  type DiscordMessageBody,
} from "#public/channels/discord/api.js";

export function normalizePostInput(message: string | DiscordMessageBody): DiscordMessageBody {
  if (typeof message === "string") return { content: message };
  return message;
}

export function expandPostBodies(body: DiscordMessageBody): readonly DiscordMessageBody[] {
  if (typeof body.content !== "string") return [body];
  const chunks = splitDiscordMessageContent(body.content);
  return chunks.map((content, index) => {
    if (index === 0) {
      return { ...body, content };
    }
    return {
      allowed_mentions: body.allowed_mentions,
      content,
    };
  });
}
