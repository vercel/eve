---
"eve": patch
---

Add a bounded `fileMemory()` provider with scope-partitioned indexed documents and model-facing save and remove tools. Non-production environments outside Vercel default to process-local storage, Vercel deployments use an attached Blob store, and other production deployments require an explicit backend.
