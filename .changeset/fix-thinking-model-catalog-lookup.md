---
"eve": patch
---

Models with slug ending in `-thinking` are now resolved to the
correct model instead of failing with `does not have known AI Gateway context window metadata` error or silently using the base model's context window.
