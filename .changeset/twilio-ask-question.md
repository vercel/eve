---
"eve": patch
---

The Twilio channel now sends `ask_question` prompts and tool approvals by SMS with numbered options, so a person can answer by replying with an option's number or label (for example `approve` or `cancel`). Previously the request was never sent and the session stayed parked.
