---
"eve": patch
---

`eve build` no longer fails with `Identifier has already been declared` when a tool callback's destructured parameter shadows a variable from an enclosing scope. This also fixes building with the `eve/extensions/git` extension, whose minified code hit the same case.
