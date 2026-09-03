---
"eve": patch
---

Fix file-memory setup failing after it creates a Vercel Blob store when the project uses Vercel CLI 57. Setup now connects the store without passing that release an unsupported output flag, so retrying repairs the partial setup normally.
