---
"eve": minor
---

Add `eve/extensions/taint`, an experimental extension that records when a session reads untrusted content so an agent-wide approval policy can ask a person before external and irreversible calls, and deny publishing.

Mount it with `export default taint({})` in `agent/extensions/taint.ts`, tag entries `reads:untrusted`, `effect:external`, `effect:irreversible`, or `sink:public`, and set `approval: taintPolicy()` in `agent/agent.ts`. `taintPolicy({ when })` gates external calls only when a confidentiality check also matches, for the Rule of Two. `taintRuntimeContext()` adds the session's exposure to model-call spans.
