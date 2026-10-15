---
"eve": patch
---

The Discord channel can now answer DMs, mentions, and thread replies. `discordChannel({ gateway: {} })` accepts messages forwarded from the Discord Gateway, and `runDiscordGatewayRelay` from the new `eve/channels/discord/gateway` entry point holds that connection, for example in a Vercel Daemon. Default Discord auth now uses the authenticator `discord` instead of `discord-interaction`, so a person gets the same principal from messages and interactions.
