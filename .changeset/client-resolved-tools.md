---
"eve": minor
---

Add `defineClientTool` for authoring client-resolved (human-in-the-loop) tools.

A client-resolved tool has **no `execute`**: eve surfaces it to the model, parks
the turn when the model calls it, and resolves the call from the client/HITL
channel (e.g. an `inputResponses` answer) rather than running server code — the
same mechanism the built-in `ask_question` uses, now available to authored
tools.

This unblocks widening/overriding `ask_question` with a richer, typed input
schema (typed HITL pickers) without the duplicate `tool_result` that a
`defineTool` override produced — authoring previously forced an `execute`, so a
parked call yielded two `tool_result` blocks for one `tool_use` id and the
provider rejected the resumed turn with "each tool_use must have a single
result". See #203.

`defineTool` is unchanged and still requires `execute`; only `defineClientTool`
may omit it.
