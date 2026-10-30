---
"eve": patch
---

A channel path that declares both `GET()` and `WS()` now accepts WebSocket upgrades, which the `GET` route used to answer as a plain HTTP request.

WebSocket routes now register for `GET` only, the method an upgrade uses, so other methods on a WebSocket-only path no longer reach its handler.
