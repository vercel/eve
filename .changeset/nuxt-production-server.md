---
"eve": patch
---

`eve/nuxt` starts a separately built eve service from `eveRoot` in non-Vercel production, using the same build-time port as its proxy.

`EVE_NUXT_PRODUCTION_ROOT` can override the deployed root at startup; externally managed origins, prerendering, and static generation skip startup, and shared Nuxt/eve output is rejected to prevent self-spawning.
