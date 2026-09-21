---
"eve": patch
---

Add the opt-in `slackChannel({ excludeOutsiders: true })` guard to reject both workspace guests and external Slack Connect members before inbound handlers or HITL responses run. The guard requires `users:read` and rejects access when membership cannot be verified; the default behavior is unchanged.
