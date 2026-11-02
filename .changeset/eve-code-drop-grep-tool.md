---
"eve": major
---

The code extension (`eve/extensions/code`) no longer mounts its `code__grep` tool, which removes about 1.6K characters of tool schema from every model step.

`eve/extensions/code/tools` still exports `grep`. To keep a structured search tool, mount it yourself with `export { grep as default } from "eve/extensions/code/tools";` in `agent/tools/grep.ts`. Delete an `agent/tools/code__grep.ts` file that exports `disableTool()`, because `eve build` now rejects it with `disables a slot with no lower-precedence source`. An `agent/tools/code__grep.ts` override that spreads `grep` keeps working as your own tool named `code__grep`.
