---
"eve": patch
---

Compaction no longer re-runs on every step when the current user message is most of the context window. After a compaction, eve keeps at most 20,000 tokens of the latest conversation word for word next to the summary, with tool results shortened to 2,000 characters; a current message larger than that keeps its start and end, and the cut-out middle is summarized. A compaction that cannot bring the history under the threshold now fails the session, without retrying the step, with an error that says to start a new session or send a smaller message.
