---
"eve": patch
---

Make optional sandbox engine loading more resilient after auto-install. eve now
probes installed engine packages in a cache-isolated worker, checks ancestor
`node_modules` directories for workspace-hoisted installs, and reports a clear
post-install diagnostic when an engine package still cannot be loaded.
