---
"eve": patch
---

Allow dynamic schedules on Vercel preview and custom-environment deployments instead of rejecting operations outside production.

The default Vercel provider uses the deployment's OIDC credentials to access its own schedule track. Preview schedules remain separate from production schedules.
