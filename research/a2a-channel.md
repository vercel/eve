---
issue: TBD
status: implemented
last_updated: "2026-10-30"
---

# Experimental inbound A2A channel

`a2aChannel` (`eve/channels/a2a`) publishes an eve agent as an
[A2A](https://a2a-protocol.org/) v1.0 server, JSON-RPC binding only. Usage, options, task states,
and limitations are in `docs/channels/a2a.mdx`; this note records the design decisions.

## Model

| A2A       | eve                                                                                      |
| --------- | ---------------------------------------------------------------------------------------- |
| context   | one session, created as an external invocation bound to the caller's principal           |
| task      | the turn its first delivery opened or joined; `taskId` encodes `(sessionId, deliveryId)` |
| messageId | the delivery's idempotency key, hashed with the owner; the delivery ID encodes it        |

An eve turn stays `running` while it waits on interactions, so one task survives any number of
prompt round trips. Nothing is stored beyond the session: reads fold the session stream. Each process keeps the folded views of its 32 most recently read sessions, so a read folds only the lines since the last read. A cold read, such as on a new function instance, still folds the whole session. A stream or subscription starts from a copy of the kept view, so that other reads folding the shared view ahead can't make it skip a status change.

```
SendMessage{}                   -> create session (new context)       -> task = turn 1
SendMessage{contextId}          -> refused while a task is unfinished; else send(queue) -> next turn
SendMessage{taskId} submitted   -> refused: no turn to join yet
SendMessage{taskId} working     -> send(steer)                        -> same turn, or its own
SendMessage{taskId} interrupted -> respond(answer matched here)        -> same turn
```

A context runs one task at a time. eve's queue rules would otherwise break the mapping: one
principal's consecutive queued deliveries merge into one turn, and a queued message steers a turn
waiting on its person. Refusing a new task while one is unfinished keeps every task its own turn
without new framework options. A new task's send waits until the session records its message, so
a client that sends tasks one response at a time never races; only two sends at the same moment
can share a turn. Queued tasks in a context can come back later with a framework option for a
delivery that always takes a turn of its own. A follow-up that missed its turn is a new task,
named by its own delivery.

## Decisions

- **Retries.** The session drops a duplicate idempotency key silently, so the channel names the
  delivery itself (`deliveryIdForMessage`, reversible so history echoes the client's IDs). A retry
  of a context's first message resolves its session through a continuation token derived from the
  same key, as eve-channel's `operationId` does. Not for anonymous callers: `none()` gives everyone
  one principal, so that lookup would hand a guessed `messageId`'s context to another caller. Their
  first messages get a random token instead, as tool sessions refuse an anonymous caller's key.
- **Reading a message.** Blocking calls and streams follow the session stream. A message is read
  once its delivery is consumed or its answer admitted and, for an answer, once the status moves
  past the prompt it answered: the answer is admitted a line before its prompt settles.
- **Prompts are text.** Status messages render prompts as on any text channel. The channel matches
  a typed answer against the task's own first question and sends it with `respond()`: eve's
  typed-answer intake matches the session's first open prompt, possibly another turn's, and passes
  unmatched text through as a message. eve's interaction JSON stays off the wire; a structured A2A
  extension would be a versioned public contract, deferred until callers need one.
- **What a status shows.** A failure keeps its first line and support id, since an error's message
  can carry an upstream page or stack frames. `toolActivity: false` keeps tool names out of
  working statuses, for agents whose callers are another organization's.
- **Subscriptions last until the end.** `SubscribeToTask` follows a task through its pauses to a
  terminal state, as §3.1.6 requires and the TCK's STREAM-SUB-002 checks: it subscribes to an
  `INPUT_REQUIRED` task, answers it, and needs the stream to last until completion. A streaming
  send ends at a pause instead. §11.7 describes streams in general closing at either; the rule
  specific to subscriptions, and the TCK, decide this one.
- **Ownership.** Sessions are read through `readOwnedInvocationRun`, shared with the MCP channel;
  unknown, expired, and foreign tasks are all `TaskNotFoundError`. The public card derives
  `securitySchemes` from the challenges the auth policy declares, without calling it
  (`declaredAuthChallenges`); a policy that declares none, such as `none()`, advertises none.

## Validation

- Scenario tests drive a real `eve dev` server through the task lifecycle; interop was checked
  manually against `@a2a-js/sdk` 1.3.0 and Python `a2a-sdk` 1.3.0.
- The [A2A TCK](https://github.com/a2aproject/a2a-tck) (JSON-RPC, `d4d6fae`) passed 63 of 64
  applicable MUSTs, every SHOULD, and 3 of 4 MAYs, behind a proxy that copied each `messageId` into
  the message text (the TCK scripts behavior by `messageId`) and made each one unique (the TCK
  reuses one per scenario, which eve reads as a retry). The proxy tags the last text part inline,
  since an answer's text parts join into one answer. Re-run after the move to one task per context: unchanged. The failing MUST is a TCK bug
  ([a2a-tck#202](https://github.com/a2aproject/a2a-tck/issues/202)); the MAY is client-chosen
  `contextId`s, unsupported because a context is a session. The TCK found the snake_case field
  name and `Content-Type` bugs, and prompted typed `error.data` and the card's `ETag`.
