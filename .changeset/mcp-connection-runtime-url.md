---
"eve": patch
---

`defineMcpClientConnection` connections now honor the URL produced by the re-imported authored module at runtime instead of the build-time snapshot. Env-driven endpoints — most notably Vercel Services bindings, whose target host is only injected at request time — resolve to the correct URL on cold start. When the module omits or blanks `url`, the compiled manifest value is still used, so existing static-URL connections are unaffected.
