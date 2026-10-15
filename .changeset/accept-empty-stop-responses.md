---
"eve": patch
---

Accept empty model responses with `finishReason: "stop"` without retrying them or reporting a model-call failure. Recovery for incomplete streams and empty non-`stop` responses is unchanged.
