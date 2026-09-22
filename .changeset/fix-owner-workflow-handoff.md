---
"eve": patch
---

Keep sessions on their original stream across consecutive deployment handoffs. Intermediate handoffs no longer end the session before the final owner completes it, preventing later handoffs from failing with a fatal Workflow SDK `Hook not found` error.
