---
"eve": patch
---

Instrumentation providers can now define a `tracePolicy` to independently control event admission and input or output content capture. The deprecated `capture` setting continues to work through an equivalent policy mapping, while providers that omit both settings capture content only for public audiences.
