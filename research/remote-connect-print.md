---
issue: https://github.com/vercel/eve/pull/5243
status: implemented
last_updated: "2026-10-23"
---

# Print a remote agent response

`eve remote connect` opens an interactive terminal UI. Scripts also need to send a single prompt to an existing agent and receive its final text without starting a UI. The former `eve remote invoke` exposed a separate resumable JSON workflow, even though it shared the same remote client and session protocol.

Add `eve remote connect --url <url> --print <prompt>`. Without `--print`, preserve the existing interactive behavior and `--input` pre-fill semantics. `--print` does not require a TTY, does not start the UI, and cannot be combined with `--input`. It uses the verified remote client and sends one message to a new session. On completion, stdout contains only the final assistant text. On turn failure or cancellation, pending input or authorization, interrupted observation, or an incomplete stream, it exits nonzero without printing a partial answer. Errors identify the session once the server has accepted it.

The command does not resume a session, interpret a prompt as an answer, or emit a JSON state capsule. Follow-up turns and request-specific answers remain operations on the client API. The CLI reads the client's settled delivery result rather than adding a second protocol for one-shot calls.
