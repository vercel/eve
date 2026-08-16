---
"eve": patch
---

Remove `glob` and `grep` from the default agent tool set. Agents can opt into either sandbox search tool by exporting `defineGlobTool()` or `defineGrepTool()` from the corresponding tool file.
