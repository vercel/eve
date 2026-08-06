---
"eve": minor
---

Add per-tool `providerOptions` passthrough and provider-native tool search injection.

`defineTool` (authored and dynamic) now accepts an optional `providerOptions` field that is forwarded verbatim to the AI SDK tool object, enabling provider features configured per tool — most notably `{ anthropic: { deferLoading: true } }` / `{ openai: { deferLoading: true } }`, which mark a tool as deferred for provider-native tool search.

When any advertised tool is deferred, the harness now injects the provider's tool-search server tool (`tool_search_tool_regex` for Anthropic, `tool_search` for OpenAI) into the model request, so the model discovers and loads deferred schemas on demand. This keeps large or dynamically discovered tool sets out of the context window and keeps the tool prefix stable across steps, preserving the provider prompt cache (#716). On providers without tool-search support, deferred tools load eagerly exactly as before.

Closes #1735.
