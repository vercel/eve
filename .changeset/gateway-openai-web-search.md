---
"eve": patch
---

`webSearch({ provider: "openai" })` selects OpenAI's hosted web search for OpenAI models routed through AI Gateway, so search runs server-side with URL citations instead of going to Exa. Other Gateway models don't get `web_search` with this setting unless you set `fallback`, for example `webSearch({ provider: "openai", fallback: "exa" })`.
