---
"eve": patch
---

`eve/nuxt` accepts a `remote` option to connect a Nuxt app to a separately deployed eve agent. On Vercel it adds an edge rewrite from `/eve/v1/**` to that agent instead of generating a co-deployed service, so `useEveAgent` keeps working same-origin with no CORS and no local `agent/` directory.
