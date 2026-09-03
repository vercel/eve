---
"eve": patch
---

Prevent Vercel Blob file memory from receiving compressed responses with weak ETags that cannot be used for conditional writes. Blob reads now request identity encoding so memory documents continue saving as they grow.
