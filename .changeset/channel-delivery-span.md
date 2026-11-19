---
"eve": minor
---

Traces now include an `agent.channel.deliver` span when a channel posts a final reply or a request for input, or fails to deliver a channel event, so a reply the user never saw shows up as a failed delivery with its error ID.
