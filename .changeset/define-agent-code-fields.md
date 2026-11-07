---
"eve": minor
---

`defineAgent` now also describes an agent defined in code, with optional `name`, `instructions`, `tools`, `skills`, `connections`, `subagents`, `definitions`, `version` and `bare` fields beside the configuration `agent.ts` already uses.

`agent.ts` files are unchanged: they keep their identity and contents in the `agent/` directory, and the build rejects these fields there, naming the file or folder to use instead. The fields' type is exported as `AgentContentsDefinition`.
