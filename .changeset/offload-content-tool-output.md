---
"eve": minor
---

`offloadContent()` from `eve/tools` writes a tool result over `maxBytes` (20,000 by default) to a sandbox file and gives the model a short note with the file's path, so a large MCP or tool result no longer fills the context window.

Set it as `toModelOutput` on `defineTool`, including a tool that spreads a built-in definition, or as `toolCall.toModelOutput` on an MCP or OpenAPI connection. `toModelOutput` now receives a second argument, `ctx`, with the `callId`, the `toolName`, `getSandbox()` and `defaultModelOutput()`, and a function that takes only the output keeps working. When the result can't be saved, because there is no sandbox or the sandbox fails to open or write, `fallback` decides what the model gets: `"inline"` (the default) the whole result, or `"summary"` only its size, shape and first lines. eve logs one warning per session.

`offloadContent()` never writes a result over 10 MB. A sandbox keeps at most 100 saved results and 100 MB of them, and a new result that takes it over removes the oldest saved results, so the model runs that tool again to get one back. A published MCP tool now returns the model's projection of its output as the result `content` (text, image and file parts), so an offloaded result stays out of it. `structuredContent` is unchanged and carries the tool's full output, so `toModelOutput` does not redact it for MCP callers.
