import { getToken } from "@vercel/connect";
import { defineTool } from "eve/tools";
import { z } from "zod";

// The connector `eve add channel/discord` creates for this project by default.
// Setup rewrites agent/channels/discord.ts and daemon/main.ts, but not this
// file, so keep it in sync if your connector's ID differs.
const DISCORD_CONNECTOR = "discord/eve-discord-agent-template";

const MAX_CONTENT_LENGTH = 1000;

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

interface DiscordMessage {
  author: DiscordUser;
  content: string;
  timestamp: string;
  attachments: unknown[];
  mentions: DiscordUser[];
}

// The runtime tool name comes from the filename, so the model sees this as
// `read_recent_messages`. Tool filenames must be snake_case ASCII.
export default defineTool({
  description:
    "Read the most recent messages in the Discord channel or thread where the person just talked to you, oldest first.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(50).describe("How many messages to read."),
  }),
  async execute({ limit }, ctx) {
    // Read the caller's channel from their verified Discord identity, never from
    // model input, so nobody can ask the bot to read a channel they aren't in.
    const channelId = ctx.session.auth.current?.attributes.channel_id;
    if (typeof channelId !== "string" || !channelId) {
      throw new Error("This tool only works in a Discord conversation.");
    }

    const botToken = await getToken(DISCORD_CONNECTOR, { subject: { type: "app" } });
    const response = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`,
      { headers: { authorization: `Bot ${botToken}` }, signal: ctx.abortSignal },
    );
    if (response.status === 403) {
      throw new Error("The bot needs the Read Message History permission in this channel.");
    }
    if (!response.ok) throw new Error(`Discord returned HTTP ${response.status}.`);

    const messages = (await response.json()) as DiscordMessage[];
    return messages.reverse().map((message) => ({
      author: displayName(message.author),
      bot: message.author.bot === true,
      at: message.timestamp,
      content: readableContent(message).slice(0, MAX_CONTENT_LENGTH),
      attachments: message.attachments.length,
    }));
  },
});

function displayName(user: DiscordUser): string {
  return user.global_name ?? user.username;
}

/** Replaces `<@id>` mentions with the names people see in Discord. */
function readableContent(message: DiscordMessage): string {
  return message.mentions.reduce(
    (content, user) => content.replace(new RegExp(`<@!?${user.id}>`, "g"), `@${displayName(user)}`),
    message.content,
  );
}
