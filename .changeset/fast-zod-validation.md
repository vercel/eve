---
"eve": patch
---

Upgrade the vendored Zod runtime to 4.5 and enable lazy schema compilation for faster internal validation with substantially lower schema memory overhead. Boolean-only checks now use Zod's validation fast path instead of constructing full parse results.
