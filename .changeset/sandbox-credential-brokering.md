---
"eve": patch
---

Add route-level Vercel Sandbox authorization with an explicit eager or on-request credential-resolution mode. On-request routes fail fast with an explanatory HTTP 428 on first use; eve then resolves the demanded credential (raising the standard interactive-authorization flow when sign-in is needed) and the agent re-runs what it needs to. Commands are never killed or replayed, demand is proxy-attested so sandbox code cannot forge it, and brokered credentials are revoked from the sandbox policy at the end of each step.
