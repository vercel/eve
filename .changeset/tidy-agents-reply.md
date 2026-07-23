---
"eve": patch
---

Fixed Slack `threadContext` with `since: "last-agent-reply"` so only replies from the installed app move the context boundary. Replies from other bots remain part of the incremental thread context.
