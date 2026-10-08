---
"eve": patch
---

Non-streaming calls on `chatgpt()` models, including context compaction, now succeed instead of failing with `Stream must be set to true`. eve now streams these requests and collects the response.
