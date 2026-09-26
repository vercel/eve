---
"eve": patch
---

Parallel tool calls from subagents that share a sandbox no longer race to start it. In one process they now wait for a single start, which fixes Docker `Conflict. The container name ... is already in use` errors on first sandbox use.
