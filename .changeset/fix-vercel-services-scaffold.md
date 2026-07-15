---
"eve": patch
---

Fix Vercel deploys for the Next.js web channel. `eve` no longer scaffolds a
`vercel.json` `experimentalServices` block, which the Vercel platform now
rejects (it requires the `services` key and a stricter schema). For Next.js the
block was also redundant — `withEve()` generates the eve service and
`/eve/v1/*` routes into the Build Output at build time — so the scaffold now
writes a minimal `vercel.json`.
