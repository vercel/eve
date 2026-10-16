---
"eve": patch
---

`chatSdkChannel` never leaves a streamed reply cut off without a trace. When the final edit of a streamed reply fails, it logs the error, posts a short notice with the error id instead of posting the reply again, and tells the model on the next message that the user hasn't seen its reply, as the Slack channel does. It also skips a final edit that would change nothing, including after the session's state is restored. An adapter that can't edit messages no longer gets the reply posted a second time beside the streamed one.
