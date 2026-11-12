---
"eve": patch
---

Anthropic models on AI Gateway now cache the system prompt across sessions, and can cache it for 1 hour.

eve adds `gateway.cacheAnchorMessageIndex: 0` next to `caching: "auto"`, so a resumed session whose cache expired reads the shared system prompt from cache instead of writing it again. An authored `cacheAnchorMessageIndex`, or `caching` set to anything other than `"auto"`, is left as it is.

On Anthropic models, eve now sends the base part of the system prompt as its own system message with the cache breakpoint, and the sections that differ by session (dynamic instructions, tasks and approvals) after it. Sessions with different channel or user instructions no longer write the shared base again.

`modelOptions.promptCache.anthropic.ttl: "1h"` now also applies to Anthropic models through Gateway. eve then turns Gateway's automatic caching off, because Gateway ignores a 1-hour TTL under it, and places its own breakpoints for 1 hour, as it does on a directly called model. The default stays `5m`.
