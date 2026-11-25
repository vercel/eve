---
"eve": patch
---

Cache Slack `conversations.info` channel kind lookups per workspace and channel so warm `app_mention` webhooks skip a serial Slack API round trip before starting or resuming a turn.
