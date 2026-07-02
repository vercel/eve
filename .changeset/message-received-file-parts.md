---
"eve": patch
---

The `message.received` stream event now includes structured `parts` (text plus
file/image attachment metadata) alongside the flattened `message` summary. The
default message reducer projects attachments as `file` message parts, so chat
UIs can render user-attached files and images instead of parsing the
`[file: …]` placeholder text. Attachment bytes and internal sandbox paths are
never projected; a `url` is included only when the attachment is a
client-resolvable `http(s)`/`data:` URL.
