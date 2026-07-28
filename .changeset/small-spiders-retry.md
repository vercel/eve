---
"eve": patch
---

Retry model calls when undici terminates a response stream after a headers or body timeout, so transient provider stalls no longer immediately fail task runs.
