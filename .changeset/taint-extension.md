---
"eve": minor
---

Add `eve/extensions/taint`, an experimental extension that applies Meta's Rule of Two: an agent-wide approval policy asks a person before an external effect only when the session has read untrusted content and holds sensitive data, and denies exports then.

Mount it with `export default taint({})` in `agent/extensions/taint.ts`, tag entries `reads:untrusted`, `reads:sensitive` (or `reads:personal`), `effect:sensitive`, `effect:external`, or `effect:export`, and set `approval: taintPolicy()` in `agent/agent.ts`. `taintPolicy({ assumeSensitive: true })` gates on untrusted content alone. `taintRuntimeContext()` adds both legs to model-call spans.
