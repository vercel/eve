---
"eve": minor
---

Add `observe: true` to channel deliveries. An observed delivery appends its message and context to the session as history without running a turn; eve buffers it on the parked or active session and folds it into the next delivery that does run a turn. The Telegram channel exposes it as `observe` on the `onMessage` result, so a group bot can follow the conversation between mentions and answer the next mention with that context. `isTelegramBotMentioned` is now exported for custom `onMessage` gating.
