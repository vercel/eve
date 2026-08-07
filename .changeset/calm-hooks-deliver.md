---
"eve": patch
---

Keep sessions resumable across eve deployment upgrades: sends now cross durable session hooks as the established `deliver` envelope (with a transitional single-payload mirror for sessions pinned to 0.30.3–0.30.8), and consumers keep accepting payloads persisted by those versions.
