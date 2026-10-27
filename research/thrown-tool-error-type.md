---
issue: "None (maintainer-requested in PR #5466)"
status: implemented
last_updated: "2026-10-27"
---

# Thrown tool error type

## Problem

A tool can fail in ways that need different responses, such as an exhausted
upstream quota and a bad request. Monitors on `execute_tool` spans read
`error.type`, but a thrown error settles with the code `ACTION_RESULT_FAILED`,
so every thrown failure reads the same.

The session already keeps the thrown error's `name` on `call.settled.error`
(#4826). The tool span never used it, and the instrumentation event exposed it
only inside `error`, which is content: absent on traces that don't record
outputs.

OpenTelemetry's `error.type` names the exception's class when an exception
ends the operation. eve reads `name`, not `constructor.name`, because server
minification renames classes.

## Rule

| Failure                                                                                                            | Span `error.type`                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Carries its own code: eve's coded failures, a thrown `{ code, message }` JSON message, a coded workflow error      | that code                                                               |
| Thrown, with a non-empty `name` other than `Error`                                                                 | the name                                                                |
| Thrown, with the `name` `Error` or empty: a plain `Error`, a subclass that doesn't set `name`, a Node system error | `ACTION_RESULT_FAILED`, or `TOOL_FAILED` for a direct `invokeTool` call |

The rule holds whether or not the trace records outputs. A tool classifies a
failure by setting `name`:

```ts
class QuotaError extends Error {
  override name = "QuotaError";
}
```

## Decision

`InstrumentationCallSettledEvent` gains an optional `errorName`, the thrown
error's `name`. Like `errorCode`, it is not content, so every provider
receives it. The OpenTelemetry provider applies the rule to `errorCode` and
`errorName`. Direct `invokeTool` calls publish both fields, and their span
applies the same rule.

| Option                                    | Cost                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1. `errorName` on the event (chosen)** | One optional field on a public type. A name built from user data reaches traces that record no outputs.                                            |
| F2. Read the name from `event.error`      | No type change, but `error.type` follows the content policy: one failure reads as its name on some traces and as `ACTION_RESULT_FAILED` on others. |
| F3. F2, and record outputs on every trace | Every span carries tool outputs and error messages, and other consumers still hit the gap.                                                         |

Honoring a thrown `code` was rejected: dependency codes such as undici's
`UND_ERR_*` would rewrite `call.settled` for every agent. An exported
`ToolError` class was rejected as a public API for what `name` already does.

## Behavior change

- Every tool that throws a named error gets that name as `error.type`:
  `TypeError`, `AbortError`, `TimeoutError`, `ZodError`, AI SDK errors such as
  `AI_APICallError`, and eve's `ToolOutputSerializationError`. `error.type`
  holds both eve's codes and error names.
- A monitor that counted tool failures through
  `error.type:ACTION_RESULT_FAILED` should count `agent.action.outcome:failed`.
- A direct `invokeTool` span without a usable name reads the call's code,
  where it read `Error`, `_OTHER`, or `failed`. Invalid input still reads
  `invalid-input`.
- Custom providers receive `errorName`, and `errorCode` on direct calls.
  `call.settled` in the session, the protocol, and the model's tool result,
  which carries only the error's message, are unchanged.
- The tracer truncates `error.type` to 128 characters. A custom `name`
  survives workflow serialization.
