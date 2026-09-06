---
"eve": patch
---

Keep conversation sessions available after a `turn.started` or `step.started` handler throws. The failed turn reports the error, and a later message can resume the same session.
