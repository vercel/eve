---
"eve": patch
---

Root sessions now accept empty model responses with `finishReason: "stop"` without retrying them or reporting a model-call failure. Recovery for delegated sessions, incomplete streams, and empty non-`stop` responses is unchanged.
