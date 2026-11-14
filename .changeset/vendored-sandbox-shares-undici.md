---
"eve": patch
---

Make the eve package smaller by having its bundled Vercel Sandbox SDK use eve's own `undici` dependency instead of a second copy of the same version.
