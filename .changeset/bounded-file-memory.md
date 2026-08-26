---
"eve": patch
---

Add a bounded `fileMemory()` provider with scope-partitioned indexed documents, a 4,000-character recalled-context budget by default, and model-facing save and remove tools. `eve dev` uses shared process-local storage, configured Vercel deployments use Blob, and every other environment requires an explicit backend.
