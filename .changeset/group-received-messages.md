---
"eve": minor
---

Default frontend hooks and the TUI now share conversation state for messages, turns, HITL requests, and child calls, including parent-reported child status when following is disabled. Default hooks return `ConversationState` instead of `EveMessageData`: update explicitly typed hook options and snapshots, and handle the new `client.child.*` events in exhaustive reducer switches. Replayed optimistic messages retain their position, child observations survive parent cancellation, and tool results and content completion render consistently.
