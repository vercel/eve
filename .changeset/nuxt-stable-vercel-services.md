---
"eve": minor
---

`eve/nuxt` now deploys the agent through Vercel's stable services model: on Vercel builds the module generates an eve Build Output service and a `/eve/v1/*` service route instead of writing legacy `experimentalServices` to `vercel.json`, which Vercel no longer routes (every agent request returned a platform NOT_FOUND). The `configureVercelJson` and `servicePrefix` module options and the `EVE_NUXT_SERVICE_PREFIX` export were removed. Delete any generated `experimentalServices` block from `vercel.json` — the module warns when it sees one — or declare the eve service and its rewrite yourself under the stable `services` field to keep managing routing manually.
