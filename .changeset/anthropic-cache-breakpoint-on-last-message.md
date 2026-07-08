---
"eve": patch
---

Fixed Anthropic prompt caching placing the final cache breakpoint one message too early. Fresh tool results were billed as uncached input every turn and only entered the cache on the following request, capping the effective cache hit rate near 50%; the breakpoint now sits on the last message of each request, so agentic tool loops get near-full prefix hits.
