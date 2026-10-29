---
"eve": patch
---

The package now ships `docs/SOURCE_MAP.json`, which maps every public export to the import paths that export it, its `.d.ts` declaration line, and its implementing module, so coding agents can look up a type without searching `dist/`.
