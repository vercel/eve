---
"eve": minor
---

Remove support for root-level `system.md` and `system.*` instruction modules in agents and local subagents. Discovery now reports a rename error, even when modern instructions coexist; rename the old file to `instructions.*`, or merge its content into existing instructions and remove it.
