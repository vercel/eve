---
"eve": patch
---

Subagent turn spans now record the dispatch that created them —
`agent.parent.session.id`, `agent.parent.turn.id`, `agent.parent.call_id`, and
`agent.subagent.name` — so a parent turn that fans out to several children can
be attributed to the exact tool call behind each one.
