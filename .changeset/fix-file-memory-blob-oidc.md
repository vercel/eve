---
"eve": patch
---

Fix file-memory setup to connect private Vercel Blob storage with `EVE_MEMORY_BLOB_*` variables and OIDC authentication without provisioning a read-write token. Prefer OIDC for attached stores and let the Blob SDK resolve and refresh tokens instead of caching them in the memory backend.
