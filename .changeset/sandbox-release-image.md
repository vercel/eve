---
"eve": patch
---

Use the base release version for default sandbox images when running commit or git-ref tarballs. Build metadata such as `+git.<sha>` no longer produces invalid image tags for Docker, microsandbox, or Vercel Sandbox.
