---
"eve": patch
---

A GitHub quote reply to an approval or question prompt, followed by `@botName Approve` or an option, now answers it. Before, the quoted prompt counted as part of the answer, so the reply reached the model as a new message and the tool asked for approval again. A comment that mentions the bot only inside a quote no longer starts a turn.
