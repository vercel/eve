---
"eve": patch
---

Sessions can now restore model history to an earlier index with `restoreHistory({ to })`. The control is serialized with turns and retains only the selected history prefix without retracting prior events or external side effects.
