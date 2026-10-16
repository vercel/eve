---
"eve": patch
---

The first answer to a tool approval now decides it. A repeated answer, for example from a double click, no longer leaves the session waiting when the tool has an approval response policy, and no longer overrides an earlier answer when it doesn't: Cancel followed by Approve stays cancelled. The note sent with the deciding answer, such as why it was cancelled, still reaches the model. An unauthenticated answer to a call that has a requester is rejected with feedback instead of settling it, so it can't pre-empt the requester's own answer. When the call has no requester, an unauthenticated answer is recorded as the anonymous principal that `none()` gives unauthenticated callers.
