---
issue: TBD
status: proposed
last_updated: "2026-11-05"
---

# What the model reads when a connection call fails

## Summary

When a connection tool call fails, the model reads the error's name and message (`error.toString()`). A protocol error from the MCP client reads as `MCPClientError: Modern MCP result is missing resultType`. The model reads that as the connector being down and tells the user so, even when the connection is fine and the call may already have run. Apps patch `modelFacingError` in eve's compiled harness to say something else, and the patch breaks whenever the bundle moves.

This proposes one optional handler beside `providedArguments` on the shared `toolCall` field, for both MCP and OpenAPI connections:

```ts
toolCall: {
  onError: (error, ctx) => string | undefined | Promise<string | undefined>,
}
```

## Semantics

- **Scope.** It runs for errors thrown while calling the connection, such as transport and protocol errors and eve's call deadline.
  - A result the server marks as an error is a tool result, not a failure. The model reads it as the server wrote it.
  - Sign-in requests (`ConnectionAuthorizationRequiredError`) bypass the handler, since eve answers them itself.
- **Only the model's text changes.** Logs, telemetry (`tool-error`), `beforeResult` hooks, and the published call result keep the original error.
  - eve carries the text on an internal `ModelFacingError` whose `cause` is the original. The harness reports the cause everywhere and gives the model the message.
- **Context.** `ctx` matches `providedArguments`' context: the connection callback context (session, approver during an approved call), `callId`, and the server's bare `toolName`. It runs inside the call's approval scope.
- **Defaults.** `undefined` keeps eve's default text. A handler that throws is logged, and the default is kept: a bug in the handler never hides the original failure.

## Alternatives

- **An agent-wide `onToolError`.** Authored tools already control their own errors, so connections are the only tools whose errors come from code the app doesn't own. A per-connection handler keeps that knowledge with the connection.
- **Rewriting errors in an authored `fetch`.** A transport hook can't see the client's own validation errors, and it shouldn't have to know what the model reads.
