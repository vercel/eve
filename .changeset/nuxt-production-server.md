---
"eve": patch
---

`eve/nuxt` starts each separately built eve agent in non-Vercel production, using the same build-time ports as its proxies.

Standalone `agent/` projects use one server; `agents/` workspaces use one server per member on consecutive ports, mounted under `/eve/<name>/v1`. `eveRoot` selects the eve project or workspace root. A failed or pending member does not block another member's routes.

Requests wait for the backend listener for up to three minutes without requiring a channel health route, and failed startup returns `503` on eve routes. With Nitro graceful shutdown enabled, shutdown cancels startup before draining requests and stops pending or running eve processes with bounded termination. Workspace-linked and installed packages use the same self-contained startup entry.

Managed startup supports Nitro's single-process `node-server` preset. Cluster and worker deployments must set `EVE_NUXT_PRODUCTION_ORIGIN` to an externally managed service at build time.

`EVE_NUXT_PRODUCTION_ROOT` can override the deployed project or workspace root at startup; externally managed origins, prerendering, and static generation skip startup, and shared Nuxt/eve output is rejected to prevent self-spawning.
