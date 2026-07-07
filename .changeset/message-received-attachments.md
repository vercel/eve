---
"eve": patch
---

`message.received` events now include structured `parts` with text and file metadata so clients can render user attachments without parsing the flattened message summary. The default message reducer projects those attachments as `file` message parts while keeping raw bytes and internal sandbox paths off the stream.
