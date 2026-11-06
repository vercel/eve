---
"eve": patch
---

Vercel sandboxes created without a snapshot now receive their configured network policy at creation, so an interrupted first open cannot leave them with unrestricted network access.

Base setup needs no network access. Reopening a sandbox preserves its live policy, including changes made through `setNetworkPolicy()`, rather than applying changed open options.

Existing sandboxes are not migrated or reset. Recycle any sandbox that may have been left unrestricted by an interrupted initialization before this fix.
