---
"eve": minor
---

`offloadContent()` from `eve/tools` writes a tool result over `maxBytes` (20,000 by default) to a sandbox file and gives the model a short note with the file's path, so a large MCP or tool result no longer fills the context window.

Set it as `toModelOutput` on `defineTool`, including a tool that spreads a built-in definition, or as `toolCall.toModelOutput` on an MCP or OpenAPI connection. `toModelOutput` now receives a second argument, `ctx`, with the `callId`, the `toolName`, `getSandbox()` and `defaultModelOutput()`, and a function that takes only the output keeps working. When the result can't be saved, because there is no sandbox or the sandbox fails to open or write, `fallback` decides what the model gets: `"inline"` (the default) the whole result, or `"summary"` only its size, shape and first lines. eve logs one warning per session.

`offloadContent()` never writes a result over 10 MB; `fallback` decides what the model gets. A published MCP tool now returns the model's projection of its output as the result `text`, so a `toModelOutput` that redacts a field also applies to MCP callers. `structuredContent` is unchanged.
