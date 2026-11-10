---
"eve": patch
---

Anthropic models on AI Gateway now cache the system prompt across sessions, and can cache it for 1 hour.

eve adds `gateway.cacheAnchorMessageIndex: 0` next to `caching: "auto"`, so a resumed session whose cache expired reads the shared system prompt from cache instead of writing it again. An authored `cacheAnchorMessageIndex`, or `caching` set to anything other than `"auto"`, is left as it is.

`modelOptions.promptCache.anthropic.ttl: "1h"` now also applies to Anthropic models through Gateway. eve then turns Gateway's automatic caching off, because Gateway ignores a 1-hour TTL under it, and caches the tools and system prompt for 1 hour and the last two messages for 5 minutes. The default stays `5m`.
