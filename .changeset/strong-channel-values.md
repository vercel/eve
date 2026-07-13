---
"eve": minor
---

Infer authored channel metadata directly from the channel definition passed to `isChannel`, without compiler-generated declarations. Use `isChannel(...)` whenever you need authored metadata type narrowing; direct `channel:<name>` comparisons continue to identify channels but no longer narrow authored metadata.

The `.eve/**/*.d.ts` TypeScript include is no longer needed. Existing apps may remove it, but leaving the unmatched glob in place does not change typechecking.
