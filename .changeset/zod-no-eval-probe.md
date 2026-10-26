---
"eve": patch
---

The browser client no longer triggers a Content Security Policy `eval` violation on pages whose `script-src` omits `'unsafe-eval'`. eve's bundled Zod now skips its `Function("")` probe and always uses its interpreted parser. Your app's own Zod and `z.config()` are not affected. Thanks @wasimxyz for reporting this in #5365.
