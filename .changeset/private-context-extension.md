---
"eve": minor
---

Add `eve/extensions/private-context`, an experimental extension that records whose private data a session read, so an agent-wide approval policy can ask a person before writes and deny personal reads in public conversations.

Mount it with `export { default } from "eve/extensions/private-context"` in `agent/extensions/private-context.ts`, tag entries `reads:personal`, `effect:external`, or `effect:export`, and set `approval: privateContext()` in `agent/agent.ts`. `strictest()` combines it with other policies, such as `taintPolicy()` from `eve/extensions/taint`.
