---
"eve": patch
---

Prevent generated web chats from replacing the same session URL on every cursor update, avoiding browser History API rate limits during streaming. Session-change callbacks continue to report cursor and inbox updates.
