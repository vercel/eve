---
"eve": patch
---

`eve/nuxt` starts a separately built eve service from `eveRoot` in non-Vercel production, using the same build-time port as its proxy.

Requests wait for backend readiness for up to three minutes, and failed startup returns `503` on eve routes. Workspace-linked and installed packages use the same self-contained startup entry.

`EVE_NUXT_PRODUCTION_ROOT` can override the deployed root at startup; externally managed origins, prerendering, and static generation skip startup, and shared Nuxt/eve output is rejected to prevent self-spawning.
