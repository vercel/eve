---
"eve": patch
---

Dynamic tools now accept an `endsTurn` function, as static tools do. A tool returned by `defineDynamic` can decide from its output whether the call ends the turn; the callback stays ordinary authored code.
