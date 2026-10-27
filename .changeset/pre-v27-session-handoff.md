---
"eve": patch
---

Sessions started on eve 0.69 through 0.83 now move to a v27 deployment the next time they receive a message while idle, or earlier when a channel prepares them for the next message, instead of staying on their original deployment until they time out. eve compacts the earlier conversation as the session moves, so the model continues from a summary; the stored transcript stays intact, and new turns continue after it. Remembered tool approvals and usage limits start over.
