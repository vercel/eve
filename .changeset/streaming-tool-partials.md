---
"eve": patch
---

Tools can stream intermediate results: `execute` may be an `async *` generator. Each yield streams to clients as an `action.partial` event carrying the full output snapshot so far, and the last yield becomes the tool result.
