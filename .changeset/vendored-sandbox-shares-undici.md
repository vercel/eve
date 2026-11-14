---
"eve": patch
---

Make the eve package about 500 KB smaller to download by bundling fewer duplicate copies of the same dependencies.

The bundled Vercel SDKs now share one copy of each dependency version they have in common, and the bundled Vercel Sandbox SDK uses eve's own `undici` dependency instead of a second copy of the same version.
