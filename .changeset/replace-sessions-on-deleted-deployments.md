---
"eve": patch
---

Start a fresh session when a channel message reaches a session whose Vercel deployment was deleted, instead of failing with `RunKeyFetchError`.

Thanks @kashifrayani for diagnosing the channel failure in #5261.
