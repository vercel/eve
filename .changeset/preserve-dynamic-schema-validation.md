---
"eve": patch
---

Preserve authored dynamic tool input and output validation during durable replay, including Zod refinements and transformations. Replay restores missing live schemas from the owning resolver or fails explicitly instead of silently weakening validation.
