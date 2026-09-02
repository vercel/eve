---
"eve": patch
---

Add `memory/file` and `eve integration setup file-memory` to provision a dedicated private Vercel Blob store automatically. Deployed file memory now prefers `EVE_MEMORY_BLOB_*` credentials while retaining generic `BLOB_*` bindings as a fallback.
