import { connectDiscordCredentials } from "@vercel/connect/eve";
import { runDiscordGatewayRelay } from "eve/experimental/channels/discord/gateway";

await runDiscordGatewayRelay({
  credentials: connectDiscordCredentials("discord/eve-discord-agent-template"),
  // Lets thread follow-ups that don't mention the bot arrive with their text. Needs
  // Message Content Intent under Bot in the Discord Developer Portal, or Discord refuses the relay.
  messageContent: true,
  // Defaults to the project's production URL; set EVE_URL to relay to `eve dev`.
  url: process.env.EVE_URL,
});
