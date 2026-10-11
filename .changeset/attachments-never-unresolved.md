---
"eve": patch
---

A turn cancelled before its first model call now stages its attachments, so a photo sent just before a follow-up message no longer breaks every later turn. File parts eve can't stage become a note instead of entering session history. Byte-valued file parts cross the queue as `data:` URLs, a string with any URL scheme reaches the channel's `fetchFile` instead of being decoded as base64, and `message.received` reports an inline file's size instead of echoing its `data:` URL.
