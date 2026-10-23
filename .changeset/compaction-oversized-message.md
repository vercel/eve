---
"eve": patch
---

Compaction no longer re-runs on every step when the current user message is most of the context window. A compacted history is now accepted only if it fits the threshold, including the compaction prompt overhead, on the provider's own token count for the messages it last measured rather than eve's character estimate; new text, such as the summary, is counted by the estimate. A current message that alone takes more than half of the compaction threshold, with or without attachments, is cut to its newest part, and the cut-off start is summarized. A compaction that cannot bring the history under the threshold now fails the session, without retrying the step, with an error that says to start a new session or send a smaller message.
