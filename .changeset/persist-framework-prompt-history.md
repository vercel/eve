---
"eve": patch
---

Preserve framework announcements in conversation history so changing task and skill snapshots append to earlier model requests instead of replacing their context. Unchanged announcements are skipped until history is cleared or compacted, and completed compaction is retained if the next model request fails.
