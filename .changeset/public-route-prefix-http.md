---
"eve": patch
---

Named agents in a multi-agent Vercel workspace now see their public route prefix in HTTP handlers, so URLs they build while serving a request include their mount.

Before, `EVE_PUBLIC_ROUTE_PREFIX` reached only the workflow function, so a route such as the board channel's registration advertised `/eve/v1/...` instead of `/eve/<agent>/v1/...`.
