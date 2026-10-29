---
"eve": patch
---

Upgrade `undici` to `8.12.3` for the security fixes published in `8.12.2`.

A TLS 1.2 server that renegotiates to a certificate for another host now fails the `web_fetch` request instead of crashing the process. Thanks @pedro757 for reporting this in #5589.
