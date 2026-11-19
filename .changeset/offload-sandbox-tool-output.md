---
"eve": minor
---

`offloadSandbox({ maxOutputTokens })` from `eve/tools` writes a tool result over the token budget to a sandbox file and gives the model a short note with the file's path, so a large MCP or tool result no longer fills the context window.

Set it as `toModelOutput` on `defineTool`, including a tool that spreads a built-in definition, or as `toolCall.toModelOutput` on an MCP or OpenAPI connection. `toModelOutput` now receives a second argument, `ctx`, with the `callId`, the `toolName`, `getSandbox()` and `defaultModelOutput()`, and a function that takes only the output keeps working. Code that calls a tool's `toModelOutput` directly, such as a test, now passes `ctx` as the second argument. Without a sandbox, the model gets the whole result and eve logs one warning per session.
