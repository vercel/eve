---
"eve": patch
---

`mcpChannel({ tools: true })` now asks for approval and sign-in over MCP: a published tool whose approval policy asks a person, or that needs a connection sign-in, answers with an MCP 2026-07-28 `input_required` elicitation and a signed `requestState` (set `EVE_MCP_REQUEST_STATE_SECRET` or `requestStateSecret`), and clients that cannot receive elicitations keep getting `approval_required` and `authorization_required`. eve MCP connections now answer a server's `input_required` approval or sign-in by asking the user whose turn made the call, then retrying the call.
