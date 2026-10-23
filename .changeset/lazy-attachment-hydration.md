---
"eve": patch
---

Model calls no longer resume the session sandbox just to render attachment labels. Images and PDFs that eve staged or already read for the session are served from a bounded in-memory cache, so the sandbox is resumed only when eve needs bytes it doesn't already hold.
