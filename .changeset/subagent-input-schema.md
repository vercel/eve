---
"eve": patch
---

Declared and remote subagents can now customize their lowered tool's input. Set `inputSchema` (Standard Schema or JSON Schema) on a subagent's `defineAgent` or on `defineRemoteAgent` to replace the default `{ message, outputSchema? }` tool shape, and pair it with a synchronous `formatInput` function to control how the structured tool input renders into the delegated prompt. Declaring `inputSchema` disables the per-call `outputSchema` escape hatch; the definition-level `outputSchema` still applies.
