---
"eve": patch
---

Process queued message deliveries separately in session-inbox order, preserving each request's auth, attachments, and context instead of merging requests under the latest sender's auth. This also keeps multiple queued requests from the same user separate.
