---
"eve": patch
---

Default scaffolded projects to `@vercel/connect@2.7.0` and require `^2.7.0` for the optional `@vercel/connect` peer.

Earlier `@vercel/connect` releases reject eve 1.0 prereleases as a peer, which made `npm install` fail with `ERESOLVE` on freshly scaffolded projects.
