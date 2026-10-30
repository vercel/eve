---
"eve": patch
---

Anthropic agents no longer fail with a 400 when the model calls a server tool, such as `web_search` or programmatic `code_execution`, beside a local tool.

Anthropic runs that server tool after the local results arrive and returns its result at the start of the next response, so the next request must end on those local results. Until that result arrives, eve now holds a message that steers the turn for one model step, holds changed catalog or skill announcements, sends an empty-response retry's note as a system instruction, and keeps compaction from separating the deferred result from its call or adding a resumption message after the local results. When the result can no longer arrive, because the turn was cancelled, failed, or retried, or a new turn starts, eve answers the server call as one whose outcome is unknown, so the model reads the new message right away.

Thanks @jam3gw for reporting this in #4890.
