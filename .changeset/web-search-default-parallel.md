---
"eve": patch
---

Use Parallel instead of Exa as the default `web_search` provider for AI Gateway models.

Agents without an `agent/tools/web_search.ts` file now search with Parallel. To keep Exa, export `webSearch({ provider: "exa" })` from that file.
