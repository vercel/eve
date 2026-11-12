---
"eve": minor
---

Slack's `approvalChannel` accepts `"ephemeral"` to show an approval or `ctx.ask()` question only to the person who started the turn, in the thread.

Everyone else sees a `Waiting on` note naming that person, which shows the outcome once the request ends. The card needs only the `chat:write` scope and keeps the conversation in the thread, unlike `"direct-message"`. A click replaces the card with the answer, because Slack can't edit an ephemeral message later.
