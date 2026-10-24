---
"eve": patch
---

Workflow and step modules can now use `?raw` and other relative asset imports. Before, `eve build` failed with `UNLOADABLE_DEPENDENCY` when a module reachable from a workflow imported a file this way, even though the same import worked in a tool.
