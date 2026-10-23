---
"eve": patch
---

Dynamic tools now accept an `endsTurn` function, as static tools do. eve replays it from a durable descriptor like `execute`, so a tool returned by a `defineDynamic` resolver can decide from its output whether the call ends the turn.
