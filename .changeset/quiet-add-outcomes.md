---
"eve": patch
---

In `eve dev`, a running slash command now pulses in its gutter, and a finished one shows its status there (`✓`, `⨯`, or `─`). When `/add` finishes, its row is replaced by a dimmed summary such as `✓ Added connection/notion`, and setup logs are no longer kept after the panel closes. Cancelling setup now shows the command to resume it instead of reporting a failure. Every setup flow, including `/deploy`, now uses the same pulse indicator.
