---
"eve": patch
---

Fix a TypeScript build error caused by a duplicate duration field in direct tool-call tracing. Direct tool spans now include the same non-framework classification as conversation tool spans.
