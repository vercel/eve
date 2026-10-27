---
"eve": patch
---

Sending a message from a web client served over plain HTTP on a host other than `localhost` no longer fails with `crypto.randomUUID is not a function`. Thanks @KingAmo for reporting this in #5415.
