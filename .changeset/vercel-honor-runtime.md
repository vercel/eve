---
"eve": patch
---

The Vercel sandbox backend now honors an author-supplied `runtime` (e.g. `vercel({ runtime: "python3.13" })`) instead of always forcing the `vercel/eve:latest` image. The default eve image is still used when no runtime is requested.
