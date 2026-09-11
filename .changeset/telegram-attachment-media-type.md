---
"eve": patch
---

Telegram channel: prefer the known attachment media type over the HTTP `content-type` header when fetching files. Telegram's file endpoint frequently returns `application/octet-stream` (or no content-type) for photos, which broke image recognition in vision models that key off the declared media type.
