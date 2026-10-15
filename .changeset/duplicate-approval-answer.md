---
"eve": patch
---

The first answer to a tool approval now decides it. A repeated answer, for example from a double click, no longer leaves the session waiting when the tool has an approval response policy, and no longer overrides an earlier answer when it doesn't: Cancel followed by Approve stays cancelled. The note sent with the deciding answer, such as why it was cancelled, still reaches the model. An unauthenticated answer to an approval that has a requester is rejected instead of passing through, and an answer that is neither Approve nor Cancel now gets feedback instead of being dropped.
