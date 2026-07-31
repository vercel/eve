---
"eve": patch
---

Subagent runs now record into the trace of the session that dispatched them instead of a disconnected trace of their own, and `eve traces` resolves either session id to it. Local traces also open a real `agent.session` root span rather than a synthesized parent, so an authored OTel sampler's root rule decides whether a session is sampled, and a session long enough to outgrow one trace rolls into numbered windows that `eve traces <session-id>` lists oldest first. Rows whose lifetime outlives the worker that opened them — `agent.session` and `agent.turn` — now show the extent of their descendants instead of `0ms`.
