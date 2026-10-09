---
"eve": patch
---

`webSearch({ provider: "native" })` uses the model vendor's own hosted search for AI Gateway models: OpenAI web search for OpenAI models, Anthropic web search for Anthropic models, and Google Search grounding for Gemini 3 and later, instead of Exa. Other Gateway models don't get `web_search` with this setting unless you set `fallback`, for example `webSearch({ provider: "native", fallback: "exa" })`. Gemini models before Gemini 3, including direct ones, no longer get Google Search, which made the model drop every other tool.
