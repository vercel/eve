---
"eve": minor
---

The published types for built-in channel states no longer include the default handlers' bookkeeping, such as Slack `taskCards` and `threadStatus`, Chat SDK streaming fields, `pendingSignIns`, posted prompt cards, `shownPromptId`, `undeliveredReplyErrorId`, and Discord's `interactionToken`, `initialResponseSent`, and `hasMessageAnchor` (read the interaction token from the Discord handle). `TelegramHitlState` is no longer exported. Addressing, identity, and audience fields are unchanged. Keep custom handler data in your own state keys instead of reading or writing these fields. `SendTurnPayload` is now exported from `eve/client`.
