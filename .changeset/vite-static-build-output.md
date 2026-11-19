---
"eve": minor
---

`eveVite()` now deploys Vite single-page apps to Vercel without a `vercel.ts`: when no framework or adapter writes `.vercel/output`, it writes a static Build Output from the client build and adds the agents to it.

The client build needs a root `index.html`; without one, the build fails and asks for `nitro()` from `nitro/vite` or an adapter that writes `.vercel/output`. A `vercel.json` that sets `rewrites`, `redirects`, `headers`, `routes`, `cleanUrls`, or `trailingSlash`, or a `vercel.ts` that doesn't use `withEve`, fails the build, because Vercel doesn't apply that routing to a Build Output. Delete a single-page app's catch-all rewrite to `index.html`, which `eveVite()` already serves, and move other routing to a `vercel.ts` that uses `withEve` from `eve/vercel`.
