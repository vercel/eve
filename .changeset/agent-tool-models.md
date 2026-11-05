---
"eve": major
---

Replace `agentWithModel` with `agent({ models })` from `eve/tools/agent`, which lists the models a root-copy task may run on.

`agentWithModel` let the model pass any AI Gateway model ID and did not tell it which models exist. `agent({ models })` takes the same entries as `auto()` from `eve/models`: a string entry is the description, and its key is the AI Gateway model ID; an object entry holds an AI Gateway model ID or an AI SDK model, with its description and optional `reasoning`, `modelContextWindowTokens`, and `modelOptions`. The model sees each key with its description and can choose only those keys. A call without `model` runs on the current model, and `agent()` with no `models` is the default tool, with no `model` input. A task keeps the model it started with, so a continuation can omit `model`. Copies and declared subagents never get this tool.

To migrate, replace `export { agentWithModel as default } from "eve/tools/agent"` with `export default agent({ models: { "<gateway-model-id>": "<when to use it>" } })`. `agent` is now this function; re-export `default` from `eve/tools/agent` to keep the default tool object.
