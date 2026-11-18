---
"eve": minor
---

`eve info` now catches common agent mistakes before runtime, lists each diagnostic with its source, and exits with code 1 when the agent fails to compile.

New checks reject tool input schemas that model providers would refuse, `ctx.agent("name")` calls to agents a workflow tool can't reach, and step-only context calls such as `ctx.getSandbox()` inside a `"use workflow"` body. Discovery now suggests the intended name for misspelled directories and files such as `tool/` or `agents.ts`, and warns about ignored `.tsx` and `.jsx` tool and hook files. Errors for missing default exports, missing tool descriptions, misnamed subagent config files, and unlisted model ids now say what to fix. `eve info --json` always prints JSON and adds `diagnostics.items`.
