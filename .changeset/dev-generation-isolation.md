---
"eve": patch
---

`eve dev` memory no longer grows with every save. Each rebuild now compiles and bundles your agent in a short-lived child process, and each new version of your code is served by a fresh worker, so old copies of authored modules no longer stay loaded. Modules imported by relative path now keep their package's `sideEffects` setting, so identical source bundles the same way on every save; in `"type": "module"` apps, default imports of older CommonJS packages that set `__esModule` now follow Node's rules. Thanks @callicles for reporting this in #5203.
