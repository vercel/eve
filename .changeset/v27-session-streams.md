---
"eve": minor
---

Session streams now use v27 facts, line-based cursors, and immutable `SessionView` snapshots queried through `eve/events`. Checkpoints require version 18; keep older sessions on their original deployments and follow the [v27 upgrade guide](https://eve.dev/docs/concepts/upgrade-to-v27-events) before updating event consumers or restoring persisted history.
