---
"eve": patch
---

Routes protected by `httpBasic()` now advertise a standards-compliant `WWW-Authenticate: Basic` challenge on 401, using an optional realm that defaults to `"eve"`; HTTP Basic credentials are normalized to Unicode NFC to match the advertised UTF-8 encoding. `routeAuth` collects challenges from the configured auth strategies instead of always emitting `Bearer`.
