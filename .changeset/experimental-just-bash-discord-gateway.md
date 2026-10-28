---
"eve": minor
---

Move just-bash `customCommands` and `filesystem` under `JustBashSandbox.environment({ experimental: { customCommands, filesystem } })`, and import their types, such as `JustBashCommand` and `JustBashFilesystem`, from `eve/experimental/sandbox/just-bash`. The Discord Gateway relay moves from `eve/channels/discord/gateway` to `eve/experimental/channels/discord/gateway`, and `experimental_runDiscordGatewayRelay` is renamed to `runDiscordGatewayRelay`.
