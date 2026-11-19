---
"eve": minor
---

`offloadContent()` from `eve/tools` writes a tool result over `maxBytes` (20,000 by default) to a sandbox file and gives the model a short note with the file's path, so a large MCP or tool result no longer fills the context window.

Set it as `toModelOutput` on `defineTool`, including a tool that spreads a built-in definition, or as `toolCall.toModelOutput` on an MCP or OpenAPI connection. `toModelOutput` now receives a second argument, `ctx`, with the `callId`, the `toolName`, `getSandbox()`, `defaultModelOutput()` and `warnOnce()`, and a function that takes only the output keeps working. Code that calls a tool's `toModelOutput` directly, such as a test, now passes `ctx` as the second argument. When the result can't be saved, because there is no sandbox or the sandbox fails to open or write, `ifNotSaved` decides what the model gets: `"full"` (the default) the whole result, or `"description"` only its size, shape and first lines. eve logs one warning per session.
