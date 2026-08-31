---
"eve": patch
---

Upgrade eve and newly generated projects to Zod 4.5, with lazy schema compilation for faster internal validation and substantially lower schema memory overhead. Boolean-only checks now use Zod's validation fast path instead of constructing full parse results.
