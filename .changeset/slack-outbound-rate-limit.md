---
"eve": patch
---

Outbound Slack calls now retry when Slack rate limits them. A `429` is replayed after the delay `Retry-After` asks for, up to three attempts, so a throttled `chat.update` or `conversations.replies` page no longer aborts the turn and drops the agent's message. Only `429` is retried — a `5xx` may have been applied before the response was lost, and replaying it would post twice. Exhausted retries throw the same `SlackApiError` as before.
