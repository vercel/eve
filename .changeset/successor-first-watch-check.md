---
"eve": patch
---

Start a successor session's next turn at once when the run it moved from has already ended, instead of up to 10s later.

A successor whose inbox waits for a handover checked whether the source run had ended only after a 10s interval, so a source that was already gone still cost that wait before the next message's turn could start. The check now runs once before the first interval. A handover part the source had already sent still reaches the successor as input.
