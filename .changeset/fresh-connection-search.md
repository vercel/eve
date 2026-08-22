---
"eve": patch
---

Compile `connection_search` as an ordinary dynamic tool source and keep discovered connection tools exclusively in durable context. Existing sessions without that context search again instead of reconstructing tools from message history.
