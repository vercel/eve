---
"eve": minor
---

`eveVite()` now deploys Vite single-page apps to Vercel without a `vercel.ts`: when no framework or adapter writes `.vercel/output`, it writes a static Build Output from the client build and adds the agents to it.

Server-rendered apps still need `nitro()` from `nitro/vite` or an adapter that writes `.vercel/output`, and the build now says so. A `vercel.json` that sets `rewrites`, `redirects`, `headers`, `routes`, `cleanUrls`, or `trailingSlash` fails the build with the fields named, because Vercel doesn't apply them to a Build Output; move them to a `vercel.ts` that uses `withEve` from `eve/vercel`.
