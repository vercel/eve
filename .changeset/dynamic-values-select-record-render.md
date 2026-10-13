---
"eve": minor
---

`defineDynamic` now takes `select`, with `render`, `record`, or both, instead of an `events` map. `select` reads what the value depends on, synchronously, and `render` makes the value from it. When there's something to await, `record` runs once per new selection, eve keeps the JSON it returns, and `render` makes the value from that. `once`, `perTurn`, and `perStep` name the common selections.
