---
"eve": minor
---

Move provided tool definitions and capability-specific helpers to dedicated `eve/tools/*` entrypoints. Replace the removed `defineBashTool`, `defineReadFileTool`, `defineWriteFileTool`, `defineGlobTool`, and `defineGrepTool` factories with the corresponding reusable definitions.
