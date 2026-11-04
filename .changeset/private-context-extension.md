---
"eve": minor
---

Add `eve/extensions/private-context`, an experimental extension that records what confidential data a session read, so an agent-wide approval policy can ask before it leaves for somewhere its readers shouldn't see it, and deny confidential reads in conversations that are too open.

Mount it with `export { default } from "eve/extensions/private-context"` in `agent/extensions/private-context.ts`, tag reads `reads:sensitive` or `reads:personal` and sinks `sink:public`, `sink:internal`, or `sink:user`, and set `approval: privateContext()` in `agent/agent.ts`. `exceedsCap` and `strictest()` combine it with `untrustedContentPolicy()` from `eve/extensions/untrusted-content` for the Rule of Two. `privateContextRuntimeContext()` adds the session's confidentiality levels, without owners, to model-call spans.
