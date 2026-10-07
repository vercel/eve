---
issue: "none; implemented by https://github.com/vercel/eve/pull/3878, https://github.com/vercel/eve/pull/3879, https://github.com/vercel/eve/pull/3880, https://github.com/vercel/eve/pull/3965, https://github.com/vercel/eve/pull/3986, and https://github.com/vercel/eve/pull/3977"
status: in-progress
last_updated: "2026-09-30"
---

# Unified conversation state for web chat and `eve dev`

The web chat and the `eve dev` TUI read the same session streams and show the same things: messages, tool calls, approvals, questions, sign-ins, and subagents. Until this change they interpreted those streams independently. The web path split its interpretation between `EveAgentStore` and `defaultMessageReducer`. The TUI had its own event translator, turn ledger, subagent pump, and renderer state. Each path answered the same lifecycle questions in its own code, and they drifted: each got some cases right that the other got wrong, and some bugs were implemented twice.

This document describes the old state models, the bugs their divergence produced, and the shared model that replaces them. A `ConversationClient` owns stream intake and a canonical `ConversationState`. `EveAgentStore` owns session operations on top of it, and the framework hooks, the `eve dev` TUI, and the Web Chat template all consume the store. Lifecycle comes from one fold of the stream, the session projection, which eve's own channel activity also reads, and every UI asks `toolCallState()` and `signInState()` where a call or sign-in stands.

The client work ships as six stacked PRs. Two server PRs sit in the middle of the stack, because the client's last steps read facts they add to the stream:

| PR                                               | Scope                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [#3878](https://github.com/vercel/eve/pull/3878) | Default message reducer: stable part IDs, authorization attempts matched by `attemptId`, replay fixes                                                        |
| [#3879](https://github.com/vercel/eve/pull/3879) | `ConversationState` and `ConversationClient` under `EveAgentStore` and the React, Vue, and Svelte hooks                                                      |
| [#3880](https://github.com/vercel/eve/pull/3880) | `eve dev` TUI as an `EveAgentStore` consumer                                                                                                                 |
| [#3965](https://github.com/vercel/eve/pull/3965) | A task call's tool part runs until its `task.settled`, not its start receipt                                                                                 |
| [#4018](https://github.com/vercel/eve/pull/4018) | Server: one durable turn state for a session's pending work ([`research/turn-state.md`](./turn-state.md))                                                    |
| [#4044](https://github.com/vercel/eve/pull/4044) | Server: stated stream facts, reported withdrawals, and the shared session projection ([`research/session-stream-contract.md`](./session-stream-contract.md)) |
| [#3986](https://github.com/vercel/eve/pull/3986) | `toolCallState()` and `signInState()`, and `ConversationState` backed by the session projection                                                              |
| [#3977](https://github.com/vercel/eve/pull/3977) | Web Chat template: activity folded under answers, pending requests inline, statuses from `toolCallState()`                                                   |

"Before" in this document means `main` after the tasks rewrite ([#3821](https://github.com/vercel/eve/pull/3821)), before this stack.

## Before: the same questions answered in several places

### Web chat

`useEveAgent` constructs an `EveAgentStore`, which feeds accepted events into a reducer (by default `defaultMessageReducer`).

- **`EveAgentStore`** held one continuous `SessionEventStream` and a session-wide event deduper. Beside the reducer it kept its own lifecycle sets, updated from raw events: `#pendingInputRequests` and `#pendingAuthorizations`, the second keyed by connection name. It decided `ready` versus `streaming` by scanning raw events with `isTurnSegmentBoundary`, not by reading reducer state. While a turn ran it refused everything except a steered message, so no input could be answered mid-turn.
- **`defaultMessageReducer`** produced `EveMessageData`. Text and reasoning parts had no IDs; the reducer found the part to extend by turn, step index, and streaming state. Authorization parts were matched by connection name.
- **`MessageResponse.result()`**, the SDK summary under the store, kept its own list of input requests.
- **The channel/web scaffold** disabled every approval while the store was busy.
- **Subagents** were not followed. The transport primitive (`session.agent(started)`) existed, but only the TUI used it.

### `eve dev` TUI

`EveTUIRunner` (about 2,800 lines) talked to `ClientSession` directly and never used the store or the message reducer.

- **Transport** was a send-response stream per turn, a `SteeringStream` merging the responses of steered messages, and a separate idle stream while the prompt was open. The idle stream and the next send handed off one session cursor.
- **`eveEventsToTUIStream`**, the TUI's reducer, was created fresh for every stream. Each instance had its own event deduper, text and reasoning maps keyed by `turnId:stepIndex` with a `stepEpoch` counter to tell reused step indexes apart, and a `seenInputRequestIds` set. It translated events into 16 imperative renderer commands such as `assistant-delta`, `tool-call`, and `finish`.
- **Runner ledgers** tracked `#pendingInputRequests`, a per-turn `turnState` (turn ID, pending approvals and questions, cancel in flight, boundary event), and `#connectionAuthRuns` and `#pendingConnectionAuths`, both keyed by connection name.
- **`SubagentPump`** (about 600 lines) followed agent-session streams and ran its own child reducer: steps, tools, and a call status of `open`, `provisional`, or `authoritative`. It also kept per-session call queues and cursors, and drove an imperative `SubagentView`.
- **`TerminalRenderer`** (about 5,600 lines) accumulated the streamed text again into mutable blocks and committed them to scrollback per turn.
- **Cancellation** sent an unguarded cancel if the turn ID wasn't known yet, then retried 8 times at 250 ms intervals.

```text
                                  root session stream
                    ┌──────────────────────┴───────────────────────┐
                    ▼                                              ▼
┌─ web chat: useEveAgent ───────────────┐  ┌─ eve dev TUI ─────────────────────────────────┐
│                                       │  │                                               │
│ EveAgentStore                         │  │ EveTUIRunner                                  │
│ ├ SessionEventStream (continuous)     │  │ ├ send-response stream per turn               │
│ ├ #seenEvents                         │  │ ├ SteeringStream (merges steered responses)   │
│ ├ #pendingInputRequests   raw-event   │  │ ├ idle stream while the prompt is open        │
│ ├ #pendingAuthorizations  sets, by    │  │ ├ #pendingInputRequests, turnState            │
│ │                         name        │  │ ├ #connectionAuthRuns, by name                │
│ ├ status ← isTurnSegmentBoundary      │  │ ├ cancel: unguarded, retried 8 × 250 ms       │
│ ├ respond() refused while busy        │  │ │                                             │
│ └ OptimisticMessageSubmissions        │  │ ├ eveEventsToTUIStream (new per stream)       │
│      │                                │  │ │   dedupe · text by turn:step + stepEpoch    │
│      ▼                                │  │ │   seenInputRequestIds                       │
│ defaultMessageReducer                 │  │ │      │ 16 imperative renderer commands      │
│   EveMessageData                      │  │ │      ▼                                      │
│   parts found by turn:step            │  │ │   TerminalRenderer                          │
│   sign-ins matched by name            │  │ │   re-accumulates text, commits per turn     │
│                                       │  │ │                                             │
│ MessageResponse.result()              │  │ └ SubagentPump ◀── agent-session streams      │
│   its own open-request list           │  │     child reducer: steps, tools, status       │
│                                       │  │     open / provisional / authoritative        │
│ scaffold: canRespond = !isBusy        │  │     per-session call queues and cursors       │
│ (no agent-session following)          │  │                                               │
└───────────────────────────────────────┘  └───────────────────────────────────────────────┘
```

| Question                                | Web chat                                                                                           | TUI                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Have we already applied this event?     | Store deduper, per session                                                                         | A new deduper per stream                                                                         |
| Which text part does this delta extend? | Latest streaming part at `turn:step`                                                               | `turn:step` plus `stepEpoch`                                                                     |
| Which requests are still open?          | Tool-part states in the reducer; the store's `#pendingInputRequests`; `MessageResponse`'s own list | Translator's `seenInputRequestIds`, per stream; runner's `#pendingInputRequests` and `turnState` |
| Is a sign-in waiting?                   | Reducer part, by name; the store's `#pendingAuthorizations`, by name                               | `#connectionAuthRuns` and `#pendingConnectionAuths`, by name                                     |
| Is the turn over, or the session busy?  | Store scan of raw events                                                                           | `visibleTurnCompleted`, `turnState.boundaryEvent`                                                |
| Has a subagent finished?                | Not tracked                                                                                        | `SubagentPump`'s own inference                                                                   |

In general, there was a lot of functionality that was duplicated between these systems, and those duplicated implementations were often divergent.

### Web-only bugs

- Rapid-fire messages rendered out of order, and a steered message appeared below the reply it steered until the server confirmed it.
- After a failed turn, partial text and reasoning stayed "streaming" forever and half-streamed tool input stayed on screen.
- A `rejected` tool result without the `TOOL_EXECUTION_DENIED` code rendered as successful output.
- A replayed tool-call or request event put an answered approval back to "approval requested".
- When a model step's approvals settled, the batch's `input.resolved` erased each approval's decision, so an approved tool showed as merely responded.
- When one model step asked to approve two tools:
  - Approving the first left the store busy, because the server sends no boundary until the batch completes. The store and the scaffold refused answers while busy, so the second approval could never be answered.
  - After an unrelated turn ended, the already-approved request became clickable again.
  - Answering it again left the store `submitted` forever, because the server ignores answers to settled requests.
- With a slow `prepareSend`, the user's message didn't appear until it resolved.
- Sending a second message while the first was still creating the session threw "A session is required before opening its stream." The TUI smoke tests found this once the TUI ran on the store.
- `MessageResponse.result().inputRequests` listed requests that had already settled within the same response. This affected any SDK caller, not only the web chat.

### TUI-only bugs

- When one model call finished some text, called a tool, then wrote more text under the same step index, the second message was dropped.
- A late `step.completed` for one step also closed a later step's still-streaming text and reasoning.
- In full reasoning mode, the final reasoning didn't replace the streamed draft when they differed.
- Approvals and questions that settled later in the same stream were still prompted.
- Answered requests were tracked per stream, so a redelivered event on a later stream asked for the same approval again.
- Duplicate events were filtered only within a stream, so reconnects could duplicate content.
- Pressing `Esc` before the turn ID arrived sent an unguarded cancel and retried it for two seconds, which could cancel a later turn.
- Failed or cancelled subagents showed as "Done".
- While an approval was open, a turn the agent started on its own, such as a scheduled run, didn't render until you answered.

### Bugs in both

Some bugs were the same mistake implemented separately in each path:

- **Sign-in completions matched by connection name.** When two people connected the same connection in one session, a completion updated the other attempt's card in the web chat and the other attempt's row in the TUI.
- **Waiting-for-callback state keyed by connection name.** With two callback-backed sign-ins to the same connection pending, the first completion cleared both. The store then treated the session as idle while the second was still waiting. The TUI's "waiting for authorization" hint used a set with the same shape.

## After: one conversation client

```text
┌─ EveAgentStore ──────────────────────────────────────────────────────────────┐
│ operations: send · steer · respond (also mid-turn) · guarded cancel          │
│             compact · clear · retire · optimistic echo                       │
│ status: derived from ConversationState                                       │
│                                                                              │
│ ┌─ ConversationClient ─────────────────────────────────────────────────────┐ │
│ │  root stream (one, continuous)      agent-session streams                │ │
│ │           │                         (followSubagents, opt-in)            │ │
│ │           ▼                                    │                         │ │
│ │  one deduper per session                       ▼                         │ │
│ │           │                         AgentStreamFollower                  │ │
│ │           │                         cursors; transport only; starts      │ │
│ │           │                         and stops by asking the state        │ │
│ │           │                         "has this session caught up?"        │ │
│ │           │                                    │ client.agent.*          │ │
│ │           ▼                                    │                         │ │
│ │  conversationReducer ◀─────────────────────────┘                         │ │
│ │    defaultMessageReducer (parts)  +  session projection (lifecycle,      │ │
│ │           │                          shared with eve's channel activity) │ │
│ │           ▼                                                              │ │
│ │  ConversationState: messages · turns · inputs · tasks · agents           │ │
│ │    read through toolCallState() and signInState()                        │ │
│ │                                                                          │ │
│ │  custom reducer (optional) ──▶ data: a view; never replaces the above    │ │
│ └──────────────────────────────────────────────────────────────────────────┘ │
└───────────────┬───────────────────────────────────────────┬──────────────────┘
       snapshots▼                                           ▼snapshots
  useEveAgent (React · Vue · Svelte)            eve dev TUI
  framework re-renders from the snapshot;       transcript: blocks keyed by stable ID
  the Web Chat template folds activity and      renderer: reconcile, commit settled
  shows pending requests inline                 blocks to scrollback
                                                tuiSessionReducer as custom data
```

Each concern has one owner:

- **`ConversationClient` decides what was observed.** It owns the root stream, one event deduper for the session, per-session cursors, and the agent-session follower.
- **`conversationReducer` decides what events mean.** It wraps `defaultMessageReducer` for messages and the session projection (`protocol/session-projection.ts`) for turns, inputs, tasks, calls, and sign-ins, and adds what only a client knows: the agent sessions its runs opened and its own answers, which read as `responded` until the stream settles them. eve's channel activity folds a session's own events through the same projection, so a UI and eve's channels agree on every call. A followed agent session is reduced by the same reducer, in its own scope, so its turn and request IDs can't collide with the root's. Below the store, `ClientSession` responses decide where they end with one shared tracker, `TurnSegment`, and the store applies the same rule to the conversation state.
- **`AgentStreamFollower` owns only subscriptions.** It starts, pauses, and resumes each agent session's stream by asking the state whether that session has shown everything its task's calls produced.
- **`EveAgentStore` owns operations.** It derives status from the conversation state instead of scanning events.
- **Each UI decides only presentation.** Focus, open drawers, and dismissed prompts stay in the UI. Whether a request is open, a call is running, a sign-in is waiting, or a subagent has finished does not: `toolCallState()` and `signInState()` answer those from the projection, and parts carry only what to show.

| Question                                     | Answered by                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| Have we already applied this event?          | The `ConversationClient` deduper, once per session across all streams                 |
| Which text part does this delta extend?      | The part's `id`: the `meta.id` of the event that created it                           |
| Which requests are still open?               | `conversation.inputs[requestId].status`                                               |
| Is a sign-in waiting?                        | `signInState(conversation, part)`, from the projection's attempt for that `attemptId` |
| Is the turn over, or the session busy?       | `activeTurnId` and `turns[turnId]`                                                    |
| Where does a tool call stand?                | `toolCallState(conversation, part)`, from the projection's `callStatus`               |
| Which call does a passed-up request wait on? | `inputs[requestId].callId`                                                            |
| Has a subagent finished?                     | `tasks[taskId].calls[callId].status`, from `task.settled`                             |

### The conversation state

```ts
interface ConversationState extends EveMessageData {
  activeTurnId?: string;
  turns: Record<string, ConversationTurn>;
  inputs: Record<string, ConversationInput>;
  tasks: Record<string, ConversationTask>;
  /** Sessions opened by this session's runs, by session ID. */
  agents: Record<string, ConversationAgentSession>;
}

interface ConversationTurn {
  turnId: string;
  status: "active" | "completed" | "cancelled" | "failed";
  /** Set while the open turn is parked on its tasks or on a question. */
  waiting?: boolean;
}

interface ConversationInput {
  request: InputRequest;
  turnId: string;
  stepIndex: number;
  taskId?: string;
  status: "open" | "responded" | "settled";
  response?: InputResponse;
  outcome?: string;
  /** This session's call that waits on the request; for a passed-up request, the call its task serves. */
  callId?: string;
  /** For an approved tool approval, the turn that runs the call, as `input.resolved` names it. */
  resumeTurnId?: string;
}

interface ConversationTask {
  taskId: string;
  name: string;
  kind: "agent" | "tool";
  calls: Record<string, ConversationTaskCall>;
}

interface ConversationTaskCall {
  callId: string;
  turnId: string;
  status: "working" | "completed" | "failed" | "cancelled";
  output?: JsonValue;
  error?: { message: string };
}

interface ConversationAgentSession {
  sessionId: string;
  name: string;
  callId: string;
  turnId: string;
  taskId?: string;
  observation:
    | { status: "not-followed" }
    | { status: "following" | "idle"; conversation: ConversationState }
    | { status: "unavailable"; conversation?: ConversationState };
}
```

- **`messages`** keeps the UIMessage-compatible shape. Text and reasoning parts carry the ID of the event that created them through appends, completion, and replay. Authorization parts track each attempt by `attemptId`, and `awaitsCallback` marks the ones a sign-in callback settles.
- **`inputs`** records every request from `input.requested` until it settles, across turns. `responded` means this client sent an answer the server hasn't settled yet. The store rejects an answer to any request that isn't `open` with "already answered" instead of sending it. `callId` places a request a subagent passes up under the call whose task asked, while its `request.action` still names the subagent's own call.
- **`turns`** tracks each root turn. A turn held by working tasks or an open question stays `active` with `waiting` set.
- **`tasks`** records every task call from `task.started` and `task.settled`. A UI can show a call's outcome without following any child stream.
- **`agents`** records every session announced by `agent.started`. `observation` describes what this client has seen, not what the agent did: `not-followed` doesn't mean the agent did nothing, and `unavailable` means the stream failed, not the agent.

At runtime the canonical state also holds the rest of the projection: every call's record and every sign-in attempt. The public type leaves those out so eve can change how it keeps them; `toolCallState()` and `signInState()` read them.

A custom reducer still receives the root server events and the client events it always did, and its output becomes `data`. The store never reads `data` for its own decisions, and `conversation` is always the canonical state. Custom reducers therefore can't break sign-in settlement, answering, or subagent following. Agent-session observations are internal to the conversation client and are not delivered to custom reducers.

### Store behavior

- The store accepts `send({ inputResponses })` while a turn is running, not only a steered message.
- Status is `streaming` while a turn is open, including a held turn. The `waiting` flag on the turn lets a UI show "waiting on tasks" or "waiting on your answer". `send()` resolves at the same point as `session.send().result()`: at a `turn.waiting` while a question is open, or when the turn ends and no sign-in is waiting for its callback.
- The user's message appears before `prepareSend` resolves. A steered message is placed above the reply it steers.
- `cancel()` waits for the turn ID and cancels only that turn. This isn't new, but the TUI now relies on it instead of its own retry loop.
- `conversation.agents` lists every agent session either way. `followSubagents: true` also follows each agent tool's session and fills in its `observation`. It is off by default because `task.settled` already gives a web UI each call's status and output.
- New methods `compact()`, `clear()`, and `retire()` expose the session operations the TUI needs. A `client` option lets a caller supply a configured `Client`.

### The TUI as a store consumer

The TUI is now one more store consumer, like the UI framework hooks. Its runner has one loop and one composer, which stays open while the agent works. Messages sent while work runs steer the active turn. Slash commands run immediately. Approvals and questions from `openConversationInputs()` open as soon as they arrive, and `Esc` or `Ctrl+C` calls the store's guarded cancel.

Rendering became declarative:

1. The store publishes a snapshot.
2. `ConversationTranscript.project()` walks `conversation.messages` and produces blocks keyed by stable IDs: part IDs, tool call IDs, and agent calls. It computes each block's `live` flag from state. Streaming text in an open turn is live, and so are running tools and their step, agent sections that haven't caught up, and sign-ins that haven't completed.
3. The renderer reconciles blocks by ID. It commits the leading run of settled blocks to scrollback once and repaints the live remainder every frame.

Tool rows take their status from `toolCallState()`, and a task shows as a start line and an end line, so a task that outlives its turn doesn't hold a row open. While a sign-in is open, the turn bar names the connection it waits for. A turn cancelled from another client puts its message back in an empty composer; a cancel from this prompt doesn't.

The TUI's event translator, steering stream, idle-stream handoff, subagent pump, turn ledger, and name-keyed sign-in maps are gone. So are two behaviors: the mid-turn message queue (and steering with queued messages), since a message sent while work runs steers it, and "preparing" placeholders for tool rows.

### Tool call and sign-in state

`toolCallState(conversation, part, { streaming })` returns a call's status (`running`, `awaiting-input`, `completed`, `failed`, `rejected`, `cancelled`, or `interrupted`), plus its output or error text. The status comes from the projection, which reads facts the stream states: a task call runs until its `task.settled`, an approved root call runs in the turn its `input.resolved` names, a call that asked for a sign-in settles `cancelled`, and a subagent's approval passed up through its task reads as waiting on that approval, then as the task's call. Only a call still running when its turn ended, or when the stream stopped, is inferred to be `interrupted`. `signInState(conversation, part)` returns where a sign-in attempt stands the same way.

Before this, the TUI and the Web Chat template each worked out a call's status from part states and turn boundaries, and they disagreed. The web chat showed every approved call as interrupted until its result arrived, because asking for approval ends the turn and the approved call runs in the next one.

### The Web Chat template

The template renders each run of tool calls, reasoning, and sign-ins between stretches of prose as one expandable activity line, with each row's status from `toolCallState()` and a followed subagent's work nested under its call. Approvals, questions, session limits, and sign-ins render inline where they arrived, outside the fold, including ones a subagent passes up, which it places by their `callId`. A root approval batch stays together, showing each answer, until the next turn picks it up.

## Public API changes

- **Breaking:** the default hook `data` is `ConversationState` instead of `EveMessageData`. Its `messages` field keeps the same shape, so existing consumers update by reading `data.messages`.
- Authorization parts gain `attemptId` and `awaitsCallback`.
- Text and reasoning parts gain an `id`. UIs should key parts by it.
- Tool parts gain `toolMetadata.eve.taskId` for a call that started a task, `toolMetadata.eve.label` for the tool's `label.start` and `label.complete` copy, and `toolMetadata.eve.errorCode` for a failed call.
- Hooks (React/Vue/Svelte) and store snapshots gain a `conversation` field holding the canonical state, even with a custom reducer.
- Hooks and the store gain `followSubagents` (default `false`). The store gains `client`, `compact()`, `clear()`, and `retire()`.
- The store accepts answers during a running turn and rejects answers to requests that are no longer open.
- The client and framework entry points export `conversationReducer`, `openConversationInputs`, `toolCallState`, `signInState`, and the conversation and tool call types.

## What the tasks rewrite took off the table

The investigation began on the pre-tasks protocol, and several problems it turned up need no client handling after the tasks rewrite:

- **Inferring a subagent's outcome.** A background subagent used to report only a working receipt, plus `subagent.completed` on success. The client had to infer provisional versus authoritative completion, failure, and cancellation from the child stream and its `session.waiting` boundaries. `task.settled` now carries each call's status, output, and error. The follower only needs to know when an agent session has caught up.
- **Sharing one child session between calls.** Following used to keep a call queue per child session and hand the cursor from one call to the next at child boundaries. `agent.started` now announces each session once, and calls reach it through their `taskId`.
- **Wake turns and sections that settled too early.** Background results no longer start new turns, and a turn stays open while its tasks work. A subagent section can no longer settle because its parent turn ended while the child kept running.
- **Withdrawn text.** `message.completed` can no longer carry a null message. That removes two divergences: the web chat deleting an earlier finished reply, and the TUI keeping a withdrawn channel-delivery marker. It also removes the removal cases from part identity.

The tasks model also makes some of this stack's work more important. Held turns are normal, so answering during an open turn becomes the main path for questions. Without these changes, it would be impossible to answer approval requests / questions while the model is active. `taskId` on inputs and authorizations lets a UI place a task's question under its task.

## Size

Line changes in `packages/eve/src` and the Web Chat registry, against each PR's base:

| PR        | Production code |      Tests |
| --------- | --------------: | ---------: |
| #3878     |              +5 |       +379 |
| #3879     |          +1,023 |     +1,813 |
| #3880     |          −2,123 |     −4,780 |
| #3965     |              +7 |        +30 |
| #3986     |            +107 |       +369 |
| #3977     |            +396 |         −1 |
| **Total** |        **−585** | **−2,190** |

#3879 adds the shared model while the TUI's copy of that logic still exists; #3880 deletes the TUI's copy. #3986 replaces #3879's own lifecycle fold with the session projection, which #4044 adds on the server. #3977's growth is the Web Chat template's new components.

## Known gaps

- `followSubagents` follows only the root's direct agent-tool sessions, with no cap on concurrent streams. The option leaves room for a predicate. Following is in memory only, so channels such as Slack have no durable way to follow agent sessions.
- A client nests a followed subagent's turns under the call that caused them by counting the child's user messages in call order, because the stream doesn't say which parent call sent each message. eve keeps that helper internal, so the TUI and the Web Chat template each carry a copy. Stating the sender on `message.received` needs a public API proposal; see [`research/session-stream-contract.md`](./session-stream-contract.md).
- The default message reducer still derives each part's `state` for UIMessage compatibility. That is a second reading of a call's lifecycle, so views should take status from `toolCallState()` rather than `part.state`.
- The React, Vue, and Svelte hooks don't expose `compact()`, `clear()`, or `retire()` yet.
