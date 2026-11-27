---
"eve": minor
---

`eve info` now lists each compile diagnostic with its source and exits with code 1 when the agent fails to compile, so it works as a check before `eve build`.

`eve info --json` always prints JSON and adds `diagnostics.items` with each diagnostic's severity, code, message, and source; a definition that throws reports one `compile/failed` item with its causes instead of crashing the command. A tool whose JSON Schema eve can't validate, such as one with an unknown `type`, now fails to compile instead of accepting its input unvalidated. Errors for missing default exports, missing tool descriptions, misnamed subagent config files, and unlisted model ids now say what to fix. New projects' `AGENTS.md` points coding agents at `eve info` as the first verification step.
