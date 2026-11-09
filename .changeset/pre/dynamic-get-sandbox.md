---
"eve": patch
---

Dynamic functions can read the session's sandbox with `ctx.getSandbox()`, the same handle tools and hooks get.

eve runs dynamic functions before every model call, so read the sandbox inside `ctx.memo`, keyed on what would change the files, such as the latest checkout call in `ctx.view`. `ctx.getSandbox()` isn't available while choosing the model.
