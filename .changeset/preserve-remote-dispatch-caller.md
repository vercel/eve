---
"eve": patch
---

Preserve remote subagent caller spans across platform HTTP ingress so schema v4 `agent.dispatch` links target the dispatching `agent.action` rather than the request span. Remote dispatch now records the prior eve parent in W3C `tracestate` while retaining standard `traceparent` transport correlation.
