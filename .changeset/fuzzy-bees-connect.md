---
"@eve/buzz-acp-adapter": patch
"eve": patch
---

Add an experimental Buzz ACP compatibility adapter that publishes threaded and top-level responses through the local Buzz CLI, prevents duplicate replies, and defaults to Buzz's owner-only author gate. Shared service agents must explicitly opt in to letting multiple accepted Buzz senders use the same eve authentication and connections.
