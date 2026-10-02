---
"eve": patch
---

Telegram, Discord, Teams, and `chatSdkChannel` now remove a question's or approval's buttons once it's answered and show the outcome, such as `Approved` or `Answered: Saturday`. This covers pressed buttons, typed replies, and requests withdrawn when a turn is cancelled. Adapters that can't edit messages keep the original prompt.
