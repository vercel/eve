---
"eve": patch
---

Anthropic models on AI Gateway now cache the system prompt across sessions.

eve adds `gateway.cacheAnchorMessageIndex: 0` next to `caching: "auto"`, so a resumed session whose cache expired reads the shared system prompt from cache instead of writing it again. An authored `cacheAnchorMessageIndex`, or `caching` set to anything other than `"auto"`, is left as it is.
