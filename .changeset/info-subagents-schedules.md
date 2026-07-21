---
"eve": patch
---

`eve info` now reports discovered subagents and schedules in both the human table and the `--json` output, matching what the CLI reference already documented. Previously both surfaces silently omitted them even though discovery resolved them correctly.
