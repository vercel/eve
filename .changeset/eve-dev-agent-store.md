---
"eve": patch
---

The `eve dev` terminal UI now runs on the shared agent store: the prompt stays open while the agent works, including turns the agent starts on its own, approvals and questions open as soon as they arrive, and slash commands run immediately. `Esc` or `Ctrl+C` cancels the running turn instead of steering with queued messages, and an approval or question names the task that asked. While a sign-in is open, the turn bar names the connection it waits for, and a turn cancelled from another client puts its message back in the prompt.
