---
"eve": patch
---

Fix `eve dev` and `eve eval` failing with `LoadCompiledModuleMapError` when an
agent's `model` is a code-defined provider object (e.g. `anthropic("claude-opus-4-8")`)
imported into the agent config from a sibling module. Source-backed model
resolution now loads the compiled module map through the same authored-source
loader the rest of the dev runtime uses, so NodeNext `.js` import specifiers
between authored source files resolve to their `.ts` sources. Previously this
path imported the compiled module map directly and skipped that mapping, which
only surfaced in the dev runtime (`eve build` + `eve start` were unaffected).
