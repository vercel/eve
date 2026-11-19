---
"eve": minor
---

`eveVite()` now deploys Vite single-page apps to Vercel without a `vercel.ts`: when no framework or adapter writes `.vercel/output`, it writes a static Build Output from the client build and adds the agents to it.

The client build needs a root `index.html`; without one, the build fails and asks for `nitro()` from `nitro/vite` or an adapter that writes `.vercel/output`.
