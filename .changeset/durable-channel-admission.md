---
"eve": patch
---

Open idle channel sessions before dispatching work and retry fixed-session sends with authenticated operation IDs. Updated session drivers suppress replayed operations; older pinned drivers reject idempotent sends before accepting them.

Slack channels can persist verified mentions and DMs before acknowledgement and prepare stored input for a trusted worker.
