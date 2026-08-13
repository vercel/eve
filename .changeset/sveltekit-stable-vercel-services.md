---
"eve": minor
---

`eve/sveltekit` now deploys the agent through Vercel's stable services model. On Vercel builds it generates an eve Build Output service and a `/eve/v1/*` service route instead of writing legacy `experimentalServices` to `vercel.json`. The `configureVercelJson` and `servicePrefix` plugin options and the `EVE_SVELTEKIT_SERVICE_PREFIX` export were removed; delete any generated `experimentalServices` block from `vercel.json`.
