---
"eve": minor
---

Add `eve/extensions/untrusted-content`, an experimental extension that records when a session reads untrusted content so an agent-wide approval policy can ask a person before external and irreversible calls, and deny publishing.

Mount it with `export default untrustedContent({})` in `agent/extensions/untrusted-content.ts`, tag entries `reads:untrusted`, `effect:external`, `effect:irreversible`, or `sink:public`, and set `approval: untrustedContentPolicy()` in `agent/agent.ts`. `untrustedContentPolicy({ when })` gates external calls only when a confidentiality check also matches, for the Rule of Two. `untrustedContentRuntimeContext()` adds the session's exposure to model-call spans.
