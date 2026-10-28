---
"eve": minor
---

`GET /eve/v1/info` now serves only operator principals and returns 403 to end users.

The route answers `service` and `runtime` principals and callers `localDev()` admits, and returns `403` with code `info_forbidden` to everyone else, so give a custom operator credential access by returning `principalType: "service"` from its `AuthFn`. The payload stays at version 5 with every field, and `client.info()` now ignores unknown fields and reads unknown enum strings as `"unrecognized"`, so handle that value when switching on fields such as `mode` or `sourceKind`.
