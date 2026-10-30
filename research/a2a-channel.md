---
issue: TBD
status: implemented
last_updated: "2026-10-30"
---

# Experimental inbound A2A channel

`a2aChannel` (`eve/experimental/channels/a2a`) publishes an eve agent as an
[A2A](https://a2a-protocol.org/) v1.0 server, JSON-RPC binding only. Usage, options, task states,
and limitations are in `docs/experimental/a2a.mdx`; this note records the design decisions.

## Model

| A2A       | eve                                                                                      |
| --------- | ---------------------------------------------------------------------------------------- |
| context   | one session, created as an external invocation bound to the caller's principal           |
| task      | the turn its first delivery opened or joined; `taskId` encodes `(sessionId, deliveryId)` |
| messageId | the delivery's idempotency key, hashed with the owner; the delivery ID encodes it        |

An eve turn stays `running` while it waits on interactions, so one task survives any number of
prompt round trips. Nothing is stored beyond the session: every read folds the session stream.

```
SendMessage{}                   -> create session (new context)            -> task = turn 1
SendMessage{contextId}          -> send(queue, turnTarget: null)            -> task = its own turn
SendMessage{taskId} submitted   -> refused: no turn to join yet
SendMessage{taskId} working     -> send(steer, turnTarget: the task's turn) -> same turn, or its own
SendMessage{taskId} interrupted -> respond(answer matched here)             -> same turn
```

`turnTarget` (`DeliverHookPayload.turnTarget`) exists because eve's queue rules would otherwise
break the mapping: one principal's consecutive queued deliveries merge into one turn, and a queued
message steers a turn waiting on its person. `null` makes a delivery a turn of its own; a turn ID
lets it steer only that turn, and it runs alone once that turn has ended. A follow-up that missed
its turn is therefore a new task, named by its own delivery.

## Decisions

- **Retries.** The session drops a duplicate idempotency key silently, so the channel names the
  delivery itself (`deliveryIdForMessage`, reversible so history echoes the client's IDs). A retry
  of a context's first message resolves its session through a continuation token derived from the
  same key, as eve-channel's `operationId` does.
- **Reading a message.** Blocking calls and streams follow the session stream. A message is read
  once its delivery is consumed or its answer admitted and, for an answer, once the status moves
  past the prompt it answered: the answer is admitted a line before its prompt settles.
- **Prompts are text.** Status messages render prompts as on any text channel. The channel matches
  a typed answer against the task's own first question and sends it with `respond()`: eve's
  typed-answer intake matches the session's first open prompt, possibly another turn's, and passes
  unmatched text through as a message. eve's interaction JSON stays off the wire; a structured A2A
  extension would be a versioned public contract, deferred until callers need one.
- **Ownership.** Sessions are read through `readOwnedInvocationRun`, shared with the MCP channel;
  unknown, expired, and foreign tasks are all `TaskNotFoundError`. The public card derives
  `securitySchemes` from the auth policy without calling it (`admitsAnonymousCallers`,
  `declaredAuthChallenges`).

## Validation

- Scenario tests drive a real `eve dev` server through the task lifecycle; interop was checked
  manually against `@a2a-js/sdk` 1.3.0 and Python `a2a-sdk` 1.3.0.
- The [A2A TCK](https://github.com/a2aproject/a2a-tck) (JSON-RPC, `d4d6fae`) passed 63 of 64
  applicable MUSTs, every SHOULD, and 3 of 4 MAYs, behind a proxy that copied each `messageId` into
  the message text (the TCK scripts behavior by `messageId`) and made each one unique (the TCK
  reuses one per scenario, which eve reads as a retry). The failing MUST is a TCK bug
  ([a2a-tck#202](https://github.com/a2aproject/a2a-tck/issues/202)); the MAY is client-chosen
  `contextId`s, unsupported because a context is a session. The TCK found the snake_case field
  name and `Content-Type` bugs, and prompted typed `error.data` and the card's `ETag`.
