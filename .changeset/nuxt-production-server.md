---
"eve": patch
---

`eve/nuxt` now starts the built eve service in non-Vercel production, matching `eve/next`. `nuxt build && node .output/server/index.mjs` serves `/eve/v1/**` without running eve separately. The eve output is read from the Nuxt server's working directory, or from `EVE_NUXT_PRODUCTION_ROOT`, and setting `EVE_NUXT_PRODUCTION_ORIGIN` still hands eve routes to a service you run yourself.
