---
"eve": patch
---

`onSlashCommand` can now start a conversation: its context adds `ctx.send`, with the same options as `onEvent`'s, and `ctx.defaultAuth` for the user who ran the command.

The Slack channel docs show how to add slash commands and thread commands such as `@bot !clear`.
