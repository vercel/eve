---
"@eve/self-modification": patch
---

Mount local `eve dev` traces read-only at `/traces` in the self-modification sandbox, and use the `session.started` trace coordinates to point the subagent at its invoking trace when local segments are available.
