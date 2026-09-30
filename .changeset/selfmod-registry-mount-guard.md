---
"eve": patch
---

The self-modification `registry_add` tool no longer pauses for approval before installing an official registry item. It now refuses items that would replace the self-modification subagent's own mount, and `search_registry` hides them.
