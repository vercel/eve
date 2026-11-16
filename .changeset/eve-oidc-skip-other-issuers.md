---
"eve": patch
---

`oidc()` refuses a token from a different issuer without fetching its own issuer's discovery document and keys, so a route that also accepts another kind of token, such as `vercelOidc()`, no longer waits on that fetch on a new server instance.
