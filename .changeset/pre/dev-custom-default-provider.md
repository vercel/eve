---
"eve": patch
---

`eve dev` now resolves a string agent model through a custom `globalThis.AI_SDK_DEFAULT_PROVIDER`, as `eve start` does, instead of routing it to the local AI Gateway connection.
