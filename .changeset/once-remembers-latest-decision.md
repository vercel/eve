---
"eve": patch
---

`once()` now remembers the latest decision people gave its prompts for a tool, so a later denial replaces an earlier approval and the next call asks again. When one delivery answers several of those prompts, a denial among its answers stands. A call cleared by a remembered approval records `clearedBy: { policy: "approval" }`; the `{ grant: { interactionId } }` variant of `ClearedBy` is removed.
