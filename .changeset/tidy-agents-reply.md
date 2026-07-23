---
"eve": patch
---

Fixed Slack `threadContext` with `since: "last-agent-reply"` so only replies from the installed app move the context boundary. Replies from other bots remain part of the incremental thread context, are labeled `bot` instead of `agent` in the injected transcript, and their file uploads are now eligible for mention attachment lookback.
