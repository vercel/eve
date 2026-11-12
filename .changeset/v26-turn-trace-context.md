---
"eve": patch
---

Turns recorded before eve 1.0 now keep their trace context when read: each converted `turn.started` carries the `trace` its stored line recorded, as a turn a current eve runs does.

A malformed recorded trace reads as absent instead of failing the line's schema.

Thanks @zackleman for reporting this in #5934.
