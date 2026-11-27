---
"eve": patch
---

eve's dev warning about dynamic values that change between evaluations now recommends a session-keyed memo, and a user-role instruction for the current time, instead of `ctx.now`, which changes between model calls and breaks the prompt cache.
