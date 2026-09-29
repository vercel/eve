---
"eve": patch
---

`agent.started` hooks and channel handlers keep the session state and sandbox changes they make, even when the child session opens while the parent's model is generating. The event still reaches the parent stream as soon as the child opens; its handler and hooks run once that model step ends, at the start of the parent's next step or before the parent waits or its session ends. For such an `agent.started`, the channel adapter handler runs after the write, so it can no longer change the event written to the stream.
