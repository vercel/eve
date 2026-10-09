---
"eve": patch
---

Direct OpenAI model calls now send a per-session `promptCacheKey`, which helps OpenAI route a session's calls to the cache holding its prompt prefix. An authored `providerOptions.openai.promptCacheKey` still takes precedence.
