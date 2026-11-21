---
"eve": patch
---

Cold starts no longer load the Vercel CLI credential reader that the bundled OIDC client only needs when refreshing a local development token.
