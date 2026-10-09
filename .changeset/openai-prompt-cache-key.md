---
"eve": patch
---

Direct OpenAI model calls now send a per-session `promptCacheKey`, so OpenAI routes each session's calls to the cache holding its prompt prefix. An authored `providerOptions.openai.promptCacheKey` still takes precedence.
