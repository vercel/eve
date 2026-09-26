---
"eve": patch
---

Parallel tool calls from subagents that share a sandbox no longer race to start it. In one process they now wait for a single start, and a Docker sandbox that loses the container name race to another process attaches to the winner's container instead of failing with `Conflict. The container name ... is already in use`.
