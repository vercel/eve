---
"eve": minor
---

`eveVite()` now deploys Vite single-page apps to Vercel without a `vercel.ts`: when no framework or adapter writes `.vercel/output`, it writes a static Build Output from the client build and adds the agents to it.

Server-rendered apps, including `appType: "custom"` and `--ssr` builds, still need `nitro()` from `nitro/vite` or an adapter that writes `.vercel/output`, and the build now says so. `headers` in `vercel.json` become routes in the Build Output and apply to every response, including the agents'. A `vercel.json` that sets `rewrites`, `redirects`, `routes`, `cleanUrls`, or `trailingSlash`, or a `vercel.ts` that doesn't use `withEve`, fails the build, because Vercel doesn't apply that routing to a Build Output; move it to a `vercel.ts` that uses `withEve` from `eve/vercel`.
