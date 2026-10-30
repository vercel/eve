---
"eve": patch
---

Slash commands you've built for the terminal UI or Web Chat can now run natively in Slack, both as Slack slash commands and as commands typed in a thread.

`eve/channels` exports `findCommand` and `runCommand`, which resolve and run a command with the same checks as the eve channel, along with the `CommandNeedsSessionError` and `CommandTakesNoArgumentError` they throw. `onSlashCommand`'s context adds `ctx.send`, with the same options as `onEvent`'s, and `ctx.defaultAuth` for the user who ran the command. The Slack channel docs show a channel that offers a shared command record both ways.
