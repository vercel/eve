import { connectDiscordCredentials } from "@vercel/connect/eve";
import { discordChannel } from "eve/channels/discord";

export default discordChannel({
  credentials: connectDiscordCredentials(
    process.env.DISCORD_CONNECTOR?.trim() || "discord/eve-discord-agent-template",
  ),
  gateway: {},
});
