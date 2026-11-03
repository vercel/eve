---
"eve": minor
---

Add `eve/extensions/taint`, an experimental extension that records when a session reads untrusted content so an agent-wide approval policy can ask a person before external effects and deny exports.

Mount it with `export default taint({})` in `agent/extensions/taint.ts`, tag entries `reads:untrusted`, `effect:external`, or `effect:export`, and set `approval: taintPolicy()` in `agent/agent.ts`. `taintRuntimeContext()` adds the session's exposure to model-call spans.
