---
"eve": patch
---

Subagent sessions now forward their nested dispatch lifecycle to the parent
channel. A channel bound to the root session sees `actions.requested` and
`action.result` for subagent and remote-agent calls made by its descendants, so
a live progress surface can show the work happening inside a delegated run
instead of stalling on the top-level call. A child's own tool calls are not
forwarded.
