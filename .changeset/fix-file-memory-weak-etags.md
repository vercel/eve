---
"eve": patch
---

Fix Vercel Blob file memory getting stuck in conflict retries after CDN compression returns a weak ETag. File memory now uses the underlying Blob object ETag for conditional writes, so documents continue saving as they grow.
