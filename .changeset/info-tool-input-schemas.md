---
"eve": patch
---

`eve info --json` now includes `toolInputSchemas`: each static tool's input schema, for the root agent and each declared subagent, in the form eve sends to the model. Subagent entries are keyed by their path from the root agent, such as `forecaster/reviewer`, so nested subagents that share a name each get their own entry. `eve/tools` also exports `serializeModelInputSchema(schema)`, which returns that JSON Schema for any tool input schema, so checks no longer need to read `.eve/` build output.
