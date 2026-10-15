---
"eve": minor
---

Simplify `eve/extensions/code`. The extension no longer ships its own read-only `code__worker` subagent or the `worker` config option: remove `worker` from `code({...})` and delegate with eve's built-in `agent` tool, which runs a copy of the agent with the same tools and sandbox. The extension's instructions are now a short list of coding practices, and the `apply_patch`, `grep`, and `review` descriptions are shorter and more accurate.
