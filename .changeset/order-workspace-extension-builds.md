---
"eve": patch
---

Build a workspace extension only after the workspace extensions it depends on, so `eve build`, `eve dev`, and `eve eval` no longer fail when an extension's packaged subagent mounts another workspace extension.

Thanks @dretanacr for reporting this in #5837.
