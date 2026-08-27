---
"eve": patch
---

Fix a TypeScript error in the generated Web Chat `tool.tsx` where `trimEnd` was called on `string | number` values returned by the tool output helper.
