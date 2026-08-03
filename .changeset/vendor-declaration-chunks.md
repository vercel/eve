---
"eve": patch
---

The published package now ships every sibling declaration chunk its vendored `.d.ts` files import. Chunk co-copying is discovered transitively from the actual relative imports instead of a hardcoded name pattern, so hash-named chunks (e.g. chat's `messages-<hash>`) no longer go missing when upstream renames them.
