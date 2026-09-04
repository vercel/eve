---
"eve": minor
---

Client context now persists in conversation history across tool steps and later turns, following the normal compaction and clear lifecycle instead of disappearing after one model call. Claude requests through AI Gateway now use explicit prompt-cache breakpoints by default, and dynamic skill announcements keep a stable system-prompt position.
