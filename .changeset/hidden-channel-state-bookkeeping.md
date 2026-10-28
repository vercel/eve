---
"eve": minor
---

Built-in channel state types no longer publish the default handlers' bookkeeping, so keep custom handler data in your own state keys.

Hidden fields include Slack `taskCards`, `threadStatus`, and the code-channel reply fields `replyThreadTs` and `pendingReplyThreadTs`, Chat SDK streaming fields, `pendingSignIns`, prompt-card fields, and Discord's `interactionToken` (read it from the Discord handle), and `TelegramHitlState` is no longer exported. `SendTurnPayload` is now exported from `eve/client`.
