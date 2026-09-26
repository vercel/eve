---
"eve": patch
---

Default frontend hooks and the TUI now share conversation lifecycle state for messages, turns, HITL requests, and optional call-scoped child streams; `data.children[callId]` exposes parent-reported child status even when following is disabled. This also fixes late user-message ordering, same-name authorization matching, stale HITL prompts, rejected tool results, and inconsistent text/reasoning completion across replay, reused steps, and failed turns.
