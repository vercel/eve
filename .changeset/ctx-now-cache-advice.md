---
"eve": patch
---

eve's dev warning about dynamic values that change between evaluations no longer recommends `ctx.now`, which also changes between model calls and breaks the prompt cache.
