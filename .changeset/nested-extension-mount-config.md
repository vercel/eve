---
"eve": patch
---

Extensions mounted inside a contributed subagent can now read the enclosing extension's configuration. Previously the nested mount saw an unbound handle, so deriving its configuration from the parent extension failed with `Invalid extension config`.
