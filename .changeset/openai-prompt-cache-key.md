---
"eve": patch
---

Direct OpenAI and `chatgpt()` model calls now send a per-session `promptCacheKey`, which helps OpenAI route a session's calls to the cache holding its prompt prefix. `chatgpt()` calls also send it as the `session-id` header the Codex backend routes on. An authored `providerOptions.openai.promptCacheKey` still takes precedence.
