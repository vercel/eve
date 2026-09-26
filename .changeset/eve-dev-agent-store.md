---
"eve": patch
---

`EveAgentStore` accepts a configured `client` and adds `compact()`, `clear()`, and `retire()` for its current session; optimistic messages now appear before `prepareSend` finishes. The `eve dev` terminal UI runs on the same store: the prompt stays open while the agent works, including turns the agent starts on its own, slash commands run immediately, and `Esc` or `Ctrl+C` cancels the running turn instead of steering with queued messages.
