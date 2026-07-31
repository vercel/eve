---
"eve": patch
---

Provider-executed tool calls (like a gateway's `web_search`) now show up in local traces: their calls and results are captured on the model span and the `/traces` viewer renders them as tool cards, with oversized outputs truncated to stay valid JSON.
