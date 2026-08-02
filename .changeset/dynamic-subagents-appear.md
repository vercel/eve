---
"eve": patch
---

Allow declared subagents to export `defineDynamic` from `agent.ts`. Session and turn resolvers can now return an agent configuration to expose it or nil to omit it from direct and Workflow delegation.
