---
"eve": patch
---

Fix unnecessary `eve dev` runtime-generation changes when Nitro installs newer Rolldown versions. No-op rebuilds and environment-only reloads now keep the active runtime snapshot unchanged instead of treating bundler debug comments as runtime changes.
