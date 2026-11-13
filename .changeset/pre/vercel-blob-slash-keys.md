---
"eve": patch
---

Fix `vercelBlob()` from `eve/memory/file/vercel` so a document whose key contains `/` can be read back after it is written.

Before, such a read returned nothing, so the next write tried to create the document again and failed because it already existed.
