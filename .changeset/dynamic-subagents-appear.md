---
"eve": patch
---

Allow declared subagents to export `defineDynamic` from `agent.ts`. Session and turn resolvers can now return the fallback agent definition to expose the subagent or nil to omit it from direct and Workflow delegation.
