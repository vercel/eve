---
"eve": patch
---

Compiling an agent bundles its authored modules into one file instead of one file per module, so loading 400 tools takes about 30 ms instead of about 500 ms, and `eve info --fresh` is about a third faster on large agents.

Each module still evaluates only when it is first loaded, and a module that throws while loading fails only its own load. The compile also stops re-emitting the same tool input schema for every subagent, writes skill packages concurrently, and skips the Workflow directive transform for modules that cannot contain a directive.
