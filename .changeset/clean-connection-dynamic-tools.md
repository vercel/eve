---
"eve": patch
---

Connection search and discovered connection tools now use the same `defineDynamic` and `defineTool` pipeline as authored tools. Dynamic tool maps now reject entries that omit `defineTool` instead of accepting unsupported raw objects.
