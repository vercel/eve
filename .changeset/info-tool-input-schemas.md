---
"eve": patch
---

`eve info --json` now includes `toolInputSchemas`: each static tool's input schema, for the root agent and each declared subagent, in the form eve sends to the model. `eve/tools` also exports `serializeModelInputSchema(schema)`, which returns that JSON Schema for any tool input schema, so checks no longer need to read `.eve/` build output.
