---
"eve": patch
---

`webSearch({ provider: "openai" })` selects OpenAI's hosted web search for OpenAI models routed through AI Gateway, so search runs server-side with URL citations instead of going to Exa. Other Gateway models with this setting keep using Exa.
