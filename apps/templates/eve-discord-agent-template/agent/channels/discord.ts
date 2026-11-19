import { connectDiscordCredentials } from "@vercel/connect/eve";
import { discordChannel } from "eve/channels/discord";

export default discordChannel({
  credentials: connectDiscordCredentials(
    process.env.DISCORD_CONNECTOR ?? "discord/eve-discord-agent-template",
  ),
  gateway: {},
});
