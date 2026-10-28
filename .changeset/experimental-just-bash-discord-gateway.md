---
"eve": minor
---

The just-bash escape hatches and the Discord Gateway relay move to experimental entries, so update their imports.

Pass `customCommands` and `filesystem` as `JustBashSandbox.environment({ experimental: { customCommands, filesystem } })` and import their types, such as `JustBashCommand` and `JustBashFilesystem`, from `eve/experimental/sandbox/just-bash`. Import `runDiscordGatewayRelay` (formerly `experimental_runDiscordGatewayRelay`) from `eve/experimental/channels/discord/gateway` instead of `eve/channels/discord/gateway`.
