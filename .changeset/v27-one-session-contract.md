---
"eve": minor
---

v27 sessions follow one contract for what a session owns, who it waits on, and what it asks people.

- **What ends with its owner.** Every turn, run, call, task, and interaction belongs to something
  that owns it. When an owner ends, what it still holds settles in the same commit: `interrupted`
  when its owner was cut short, `abandoned` when a retry replaced it. An explicit outcome in the
  commit wins.
- **Turns pause only for people.** `turn.paused` means the turn waits on a person, and its
  `awaiting` names the interactions. A turn waiting on its own work, such as tasks, keeps running,
  and nothing announces a resume: the next fact under the turn says so. `turn.resumed` is gone.
- **One interaction model.** Approvals, questions, sign-ins, and the budget prompt are all
  interactions, on the stream and in clients: `AskedInteraction`, answered with
  `Answer { interactionId, optionId?, text? }`. Clients, evals, channels, workflow tools, and
  approval policies use interaction and answer names throughout, such as `send({ answers })`,
  `ConversationState.interactions`, `requireInteraction()`, `onAnswers`, `ToolQuestion`, and
  `request.interactionId`. Sign-ins join the same lists; an interaction about no call, such as a
  sign-in or the budget prompt, is an `interaction` message part. A relayed request carries the
  facts its child committed, one commit at a time.
- **Calls read their row.** A message's tool part is its call's row: a `tool` part (`EveToolPart`)
  with the call's `status` and `outcome`, `label`, `input`, `output`, `error`, `taskId`, and the
  latest approval or question about it as `interaction`, instead of the AI SDK `dynamic-tool`
  states. Messages are derived from the shared tables, with no `step-start` parts.
  `toolResultFrom` takes a settled call row.
- **`data` is the conversation.** Custom reducers (`useEveAgent({ reducer })`,
  `EveAgentReducer`), `conversationReducer`, `defaultMessageReducer`, `toolCallState`, and the
  snapshot's separate `conversation` are gone: derive other state from `events`, or read saved
  events with `conversationOf(events)`. `transcriptReducer(options)` is
  `transcriptOf(events, options)`.
- **MCP and `eve invoke`.** The MCP channel's `input_required` and `authorization_required`
  invocations list `interactions` keyed by `interactionId`, and `agent_update` answers name them
  the same way. `eve invoke` ends a run that needs a person with one `input-required` status.
- **Model attempts.** `model.started` repeats once per attempt, with `attempt`, and
  `model.retried` records an attempt that failed and is tried again, before the backoff.
- **What a later release can add.** Within stream version 27, a minor release can add facts that
  only add information, progress records, optional fields, outcomes, kinds, displays, and option
  styles. A terminal fact with an outcome a reader doesn't know still ends its row, and outcomes
  parse open, so an older parent accepts what a newer child relays. Keep a default branch when you
  switch on one of these values.
- **Instrumentation** derives its events from each committed fact. Input events name their
  interaction (`interactionId`, `call`, `answer`), calls closed with their owner report
  `cancelled` or `abandoned`, and approval spans keep trace schema 4.
- **The budget prompt is asked once.** An answer that is neither Continue nor Stop is refused, and
  the prompt stays open for another.
