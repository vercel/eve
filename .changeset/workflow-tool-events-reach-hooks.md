---
"eve": patch
---

A workflow tool's `action.partial` updates now reach the channel adapter, stream-event hooks, and instrumentation, like the events a turn publishes, and the `input.resolved` a session emits when a question raised inside a call is answered or withdrawn now reaches the channel adapter and stream-event hooks. Both were previously written only to the session stream.
