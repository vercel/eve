---
"eve": patch
---

Cancelling a session now fans the cancellation out to its subagent descendants immediately at request time, instead of only when the parent's workflow run wakes and settles. A parent suspended on the very child it needs to cancel can no longer strand that child: descendants are derived from the session's durable event stream and cancelled recursively (local and remote) as soon as the cancel request is accepted, with the settle-time cascade remaining as a durable backstop.
