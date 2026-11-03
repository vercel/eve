---
"eve": patch
---

The provided `bash` tool shows the model its output as plain text instead of JSON, so source code, diffs, and test logs reach the model without escaped newlines and quotes.

The model reads stdout, then any stderr after a `[stderr]` line, then a final `[exit code: N]` line; for a command still running, its instructions replace the exit code line. The tool's `execute` output, its output schema, and `call.settled` events keep the structured fields. Authored code that reads the conversation, through `ctx.messages` in tools or `ctx.messages()` in dynamic capabilities, sees this text for new `bash` results, and sessions keep the JSON results they already saved. A `bash` tool published over MCP sends the text in `content[0].text`, and its `structuredContent` keeps the structured fields. Wrappers that spread `bash` keep the plain-text view: a wrapper's `execute` that returns a string reaches the model as text, and any other shape as JSON.
