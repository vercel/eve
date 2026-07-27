---
"eve": patch
---

Include normalized authenticated user IDs and optional display names in session attributes, `turn.started` events, and OpenTelemetry turn/model-call attributes. Built-in message channels provide presentation names when available, with accepted Slack messages using cached profile lookup when webhook payloads omit the name.
