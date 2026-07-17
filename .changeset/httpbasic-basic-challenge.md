---
"eve": patch
---

Routes protected by `httpBasic()` now advertise `WWW-Authenticate: Basic` on 401 (with an optional `realm`); `routeAuth` collects challenges from the configured auth strategies instead of always emitting `Bearer`.
