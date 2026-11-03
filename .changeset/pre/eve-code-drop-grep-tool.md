---
"eve": major
---

The code extension (`eve/extensions/code`) no longer mounts its `code__grep` tool, which removes about 1.6K characters of tool schema from every model step.

To keep a structured search tool, run `eve add tool/grep`, which writes `agent/tools/grep.ts` re-exporting `eve/tools/grep`. `eve/extensions/code/tools` still exports the same `grep` definition. Delete an `agent/tools/code__grep.ts` file that exports `disableTool()`, because `eve build` now rejects it with `disables a slot with no lower-precedence source`. An `agent/tools/code__grep.ts` override that spreads `grep` keeps working as your own tool named `code__grep`.
