---
"eve": patch
---

The Linq channel now rejects inbound webhooks with a 401 whenever its webhook verifier returns any falsy value, including the `null` that `vercelOidc()` returns for a missing or invalid token. Previously only `false` rejected a request, so Vercel Connect setups without a `signingSecret` accepted unsigned webhooks.
