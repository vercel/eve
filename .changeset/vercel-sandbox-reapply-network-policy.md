---
"eve": patch
---

Vercel sandboxes created without a snapshot now receive their configured network policy at creation, so an interrupted first open cannot leave them with unrestricted network access.

Base setup needs no network access. Reopening a sandbox preserves its live policy, including changes made through `setNetworkPolicy()`, rather than applying changed open options.

On upgrade, starts without recorded provider state use a new sandbox namespace, so they cannot reuse a legacy sandbox whose policy initialization may have been interrupted. This includes keyed tool sessions: their first access creates a fresh filesystem, leaving the old sandbox untouched.

Recorded legacy sessions resume without resetting a policy other than `allow-all`. If Vercel reports `allow-all` or no policy, eve refuses the resume because it cannot distinguish intentional open access from interrupted initialization. Start a new eve session in that case; eve does not delete the old filesystem. Sandboxes created in the new namespace can still resume intentional `allow-all` policies.
