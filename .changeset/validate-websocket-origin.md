---
"eve": patch
---

Add `validateWebSocketOrigin`, an opt-in helper for `WS()` `upgrade` hooks that enforces an `Origin` allowlist to defend against cross-site WebSocket hijacking and DNS rebinding. It returns a `403` to reject a missing or non-allowlisted `Origin` and `undefined` to proceed; no default behavior changes.
