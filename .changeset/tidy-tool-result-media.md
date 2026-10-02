---
"eve": patch
---

Stop persisting file payloads returned by tools after a turn settles. Session history now keeps a text stub with the filename and media type instead, so later turns no longer resend or re-store those bytes.
