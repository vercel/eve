---
"eve": patch
---

A `HEAD` request to a channel path that declares `GET` but not `HEAD` now gets `405 Method Not Allowed` with an `Allow` header instead of `404`, and the `GET` handler doesn't run.

Declare `HEAD()` on a path to answer `HEAD` requests there. Paths that already declare `HEAD()`, such as `/` and `/eve/v1/health`, are unchanged.
