---
issue: https://github.com/vercel/eve/pull/6199
status: in-progress
last_updated: "2026-11-10"
---

# Multiplayer sessions

## Problem

Several people share one session when they work in the same Slack thread, code channel, or GitHub
issue. Three things go wrong today.

**Other people's messages wait.** Only a turn's own caller steers it. A message from anyone else
waits for the turn to end and then runs as its own turn. The agent goes quiet for everyone but one
person, and the model never gets to decide whether a comment changes what it's doing.

**A turn that waits on a person blocks.** While a turn waits on an approval or a sign-in, it takes
only the answer and its caller's messages. The caller's own message cancels what the turn waited
on: the approval is withdrawn, the sign-in is withdrawn and can't be asked for again in the turn,
and the work the call was doing is lost.

**The agent can act as the wrong person.** Alice asked for a pull request and the turn ended
without one. Bob replied "oh this is flaky". His reply started a turn as Bob, the model picked up
Alice's request from the history, and the pull request opened with Bob's GitHub account. eve had
no way to run that call as Alice.

[#6199](https://github.com/vercel/eve/pull/6199) proposed steering by anyone with approval helpers
that ask the caller on a mismatch. Review found that it paused turns more often while other people
still couldn't steer a paused turn, and that the approval flags it added composed badly. This plan
replaces it.

## Rules

1. **A turn has one caller.** The caller is the sender of the message that started the turn, and
   never changes while the turn runs. Unchanged from today.
2. **No message waits on a person.** A message from anyone the channel admits joins the running
   turn, including a turn that waits on an approval or a sign-in. It changes what the model reads,
   never who the caller is.
3. **A call gets a person's identity only from that person.** eve hands a person's identity to a
   call when they were the last to speak as the model made the call, or when they approved that
   call. Otherwise eve asks them, or refuses the call where it can't ask.
4. **The model is told who is speaking.** eve names the sender when the speaker changes, on every
   channel.

A session with one person never reaches rules 2 to 4.

## The stack

The plan lands as three stacked pull requests. Each leaves `main` coherent on its own.

| Pull request    | Adds                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------- |
| 1. Steering     | Anyone steers a running turn, `auth.sender`, the sender line, and rule 3 as a refusal.    |
| 2. Open waits   | A turn that waits on a person takes messages, and what it waited on stays open as a task. |
| 3. Ask a person | eve asks instead of refusing, `callerConfirmation`, and `ctx.getToken(provider, { as })`. |

## API

```ts
interface SessionAuth {
  readonly initiator: SessionAuthContext | null; // who started the session
  readonly current: SessionAuthContext | null; // the turn's caller
  /** Who sent the latest message the turn read. Equal to `current` until someone else speaks. */
  readonly sender: SessionAuthContext | null;
}
```

```ts title="agent/agent.ts"
export default defineAgent({
  // After someone else speaks, ask the caller before a call uses their identity.
  // "always" (default): each time. "once": once for each person, for the session. "never": don't ask.
  callerConfirmation: "once",
});
```

```ts title="agent/tools/gh.ts"
export default defineTool({
  description: "Run one gh command. Set actor to the person whose request it carries out.",
  inputSchema: z.object({ command: z.string(), actor: z.string().optional() }),
  async execute({ command, actor }, ctx) {
    // The named person's token. Omit `as` for the caller's.
    const { token } = await ctx.getToken(github, { as: actor });
    return runGh(command, token);
  },
});
```

`ConnectionAuthorizationFailedError` gains `reason: "confirmation_required"`. Nothing is added to
connection or channel definitions, and the approval helpers don't change.

## Semantics

### Steering

`turnPolicy: "steer"` joins the running turn whoever sent the message, on every channel.
`"queue"` still waits for the turn to end.

- `auth.current`, the turn's memory scope, its hooks, and its dynamic functions stay the caller's.
- `auth.sender` changes only as a step reads a message, so every call the model makes in one step
  sees the same value. Only a message changes it. Text the caller types counts, even when it
  answers a request. A pressed answer doesn't: it puts no words in front of the model.
- When messages from several people are waiting, eve adds them to the conversation in the order
  they arrived, each as its sender's. The model runs once it has read them all.
- Principals are compared by identity, as steering compares them today. Unauthenticated and
  anonymous senders are one person.
- A delivery without `auth` isn't another person. It acts as the turn's identity and leaves
  `auth.sender` unchanged, so a channel that admits several people must set `auth`. A hook's
  continuation is one: the turn it starts keeps the last sender.
- Another person's delivery without a message only answers requests. The context and history
  sent with it don't reach the model.

### Who is speaking

When a message's sender differs from the sender of the session's previous message, eve adds one
line of context before it that names both by `principalId`. The line is part of the conversation,
so it stays the same on later steps. It doesn't appear in `delivery.consumed`. Channels keep
adding what they know, such as Slack's display names.

The model needs this to follow rule 3's refusal, and to name a person for `as`.

### The identity rule

A call acts as a person when it reads a token for a `principalType: "user"` provider or
connection, calls a `forwardPrincipal` connection, or calls a remote agent that forwards the
caller. By default that person is the caller.

eve hands out the caller's identity when the caller was the last to speak as the model made the
call. After someone else's message joins the turn, the call needs the caller's approval:

- **Refused (pull request 1).** The call fails with `ConnectionAuthorizationFailedError`,
  `reason: "confirmation_required"`, `retryable: false`. Nothing pauses. The message tells the
  model that someone else has spoken, and to ask the caller to confirm before it retries. The
  caller's next message makes them the last to speak.
- **Approved.** A call the caller approved runs with their identity, whoever spoke last, and
  reads the caller as `auth.sender`. The
  caller approves a call by answering its approval or by completing its sign-in. An approval
  covers its own call only: it doesn't change `auth.sender`, so the next call is judged on its
  own. Another person's approval, allowed by a `response` policy, doesn't release the caller's
  identity.
- **Asked (pull request 3).** See [Asking a person](#asking-a-person).

A call that waits on a person runs as it was asked. It keeps the sender it had then, and messages
read while it waited don't change what it gets.

Listing a connection's tools uses the caller's identity even after someone else spoke: it runs
nothing the model chose. A local subagent inherits the sender of the call that started it. Rule 3
doesn't cover app-scoped connections or tools that use no credentials. A tool that decides from
the caller's role reads `auth.sender` as well as `auth.current`. eve's own checks do: `gh` with
app tokens and deployed self-modification ask `authorize` about both people, and
`openCodeChannel()` is unavailable until the caller speaks again.

### Waiting on a person

A turn that waits on an approval or a sign-in stays open, as today. With no new message, nothing
changes: the answer runs the call, and the call's result is its tool result.

A message from anyone joins the waiting turn, and what the turn waited on stays open:

```text
turn.started                      Alice: "deploy to staging"
  deploy asks for approval        interaction.opened, turn.paused
Bob: "also update the changelog"  joins the turn; deploy becomes task t1, its request still open
  the model edits the changelog   turn.paused: t1 waits on Alice
Alice approves                    deploy runs as Alice; its result arrives as task.result
  the model replies               turn.settled
```

- Each call the turn waited on becomes a [task](../docs/tools/tasks.md). The call's result in the
  conversation is a receipt, and the `[Tasks]` note lists what the task waits on.
- The request stays open and its card stays usable. Approving runs the call as it was asked, and
  its result arrives in a `task.result` message. A denial arrives the same way.
- A sign-in stays open too. Once the person connects, the call runs as the person who signed in.
- The model can drop a call the message made unnecessary with `eve__task_cancel`. The request is
  withdrawn and the call doesn't run.
- The turn can't end while such a task waits, as with any task. Cancelling the turn withdraws it.
- While a request is open, a `"queue"` message joins too, because the turn can't end until the
  person acts. This matches today's rule for the caller's own message.

Unchanged: the budget prompt still takes its answer before any message. A message still stops an
`execute` workflow call, so a question from `ask_question` ends `withdrawn` and the model asks
again if it still needs the answer. Only the caller's text answers a request by text; another
person's text is a message.

### Asking a person

Where the channel can show a request, eve asks instead of refusing. The call stops as it does for
a sign-in, and eve opens an approval request for the person whose identity the call needs. Only
that person can approve it.

- The request names the call and the people who spoke since the person last did, and quotes the
  latest message. The person approves what was said, not only the call.
- Approving runs the call again from the top, as a sign-in does, with that person's identity. When
  the person is the caller, approving also makes them the last to speak.
- Cancelling fails the call. The model can also drop it with `eve__task_cancel`.
- The request doesn't hold the turn. It is a wait like any other, so other people keep steering.
- Where eve can't ask, such as a channel without requests, the call is refused as in pull
  request 1.

`callerConfirmation` on the agent decides when the caller is asked:

| Value      | After someone else speaks                                                           |
| ---------- | ----------------------------------------------------------------------------------- |
| `"always"` | Ask the caller each time. The default.                                              |
| `"once"`   | Ask the caller once for each person. Approving covers that person's later messages. |
| `"never"`  | Don't ask. Anyone the channel admits steers the turn with the caller's identity.    |

`"once"` remembers for the caller and the person until the session ends. Only approving a request
is remembered; a message isn't. The root agent's value applies in its local subagents.

### Acting for someone else

`ctx.getToken(provider, { as })` reads the token of the person `as` names instead of the caller's.
`as` is a `principalId` from a sender line, so it names someone who has spoken in the session.

Rule 3 decides the same way for everyone. The named person's token is handed out when they were
the last to speak as the model made the call, or when they approved the call. Otherwise eve asks
them, signing them in if they haven't connected, or refuses where it can't ask.
`callerConfirmation` doesn't apply to a person who isn't the caller: their identity always needs
them.

The git extension's `gh` tool takes an `actor` input and passes it as `as`. In the incident, the
model names Alice, eve asks Alice, and the pull request opens as Alice. If it names Bob, the call
runs as Bob: he spoke last, and eve can't tell that from "open it".

## Scenarios

| Scenario                                                             | Result                                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Alice's turn is running. Bob adds "it's the retry logic in foo.ts".  | Joins the turn. The next `gh` call asks Alice, quoting Bob, and the pull request opens as her. |
| Alice's turn waits on her approval. Bob says "wait, use staging".    | Joins the turn. The model cancels the waiting call and asks again for staging.                 |
| Alice's turn waits on her sign-in. She adds "also bump the version". | Joins the turn. The sign-in stays open, and its call runs once she connects.                   |
| Alice's turn is running. Bob asks for his own open pull requests.    | Joins the turn. `gh` names Bob, who spoke last, and runs with his token.                       |
| Alice's request failed. Bob replies "oh this is flaky".              | Bob's turn. `gh` names Alice, eve asks her, and the pull request opens as Alice.               |
| An outsider comments on a GitHub issue during a maintainer's turn.   | Joins the turn. A call that uses the maintainer's identity asks the maintainer first.          |
| One person, any channel.                                             | Nothing changes.                                                                               |

## Security model

eve hands a person's identity to a call in two cases:

- they were the last to speak as the model made the call, or
- they approved that call: its approval, its sign-in, or eve's request for their identity.

Both are decided from who sent which message and who pressed which button, never from what the
model said. A sender line a person types into their own message can mislead the model, but it
can't change either fact.

What remains:

- A turn's first calls. The caller just spoke, so their identity is available to whatever the
  model does next. Naming the person with `as` makes a wrong choice less likely, not impossible.
- `callerConfirmation: "never"` and `"once"` are the author's decision to trust the people a
  channel admits.
- Checks that read only `auth.current`. Another person's message can now reach a tool in the
  caller's turn, so a role check also reads `auth.sender`.

## Alternatives considered

| Alternative                                             | Why not                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Approval helpers that ask on a mismatch (#6199)         | Two mechanisms for one rule, more pauses, and flags that had to compose with every other approval feature. |
| Let anyone's message withdraw what the turn waits on    | The work is lost, cards churn in a busy thread, and a withdrawn sign-in can't be asked for again.          |
| Any answer from the caller makes them the last to speak | Approving an old or unrelated card would release their identity for what someone else said since.          |
| Act as whoever spoke last                               | Alice's work would finish as Bob. This is the incident.                                                    |
| Switch the turn's caller to the latest sender           | The same, with the caller's memory scope and hooks changing mid-turn.                                      |
| eve adds an `actor` argument to every tool              | eve would change schemas the author wrote. `as` keeps the field the author's.                              |
| A third turn policy that keeps other people waiting     | Steering is the goal. An agent that needs every message to wait has `"queue"`.                             |

## Compatibility and validation

- **Steering.** Another person's message joins the running turn on every channel. `"queue"` is the
  way to make messages wait.
- **Identity.** In a turn someone else has joined, a call that uses the caller's identity is
  refused or asks first. Sessions with one person don't change.
- **Waits.** A message no longer withdraws an approval or a sign-in. Clients that render requests
  need no change: the request stays `open`, and a later `turn.paused` names it again.
- **Role checks.** The auth, security, and Slack docs tell authors to read `auth.sender` in checks
  that used `auth.current` alone, and the changeset says so.
- **Additive API.** `SessionAuth.sender`, `callerConfirmation`, the `as` option, and the
  `confirmation_required` reason.

Each pull request carries its own evals under `agent-tools-hitl/evals/hitl/multiplayer`, with unit
and integration tests for what the fixtures can't reach:

1. Another person's message joins a running turn; a tool reads `auth.sender`; messages from two
   people are both read before the model answers; the caller's token is refused after someone else
   speaks and released by the caller's reply; a call the caller approved keeps their token; a
   session with one person never changes.
2. A message joins a turn that waits on an approval and the approval stays open; approving later
   runs the call and delivers `task.result`; the model cancels a waiting call; a sign-in survives
   its caller's message.
3. eve asks the caller and quotes the message; only the caller approves; `"once"` asks once for
   each person; `"never"` doesn't ask; `gh` with `actor` asks the named person and runs with their
   token.

## Out of scope

- Naming a person for connection tools. Their schemas belong to the server, so `as` reaches
  authored tools only. Rule 3 still guards the caller's identity there.
- A function for `callerConfirmation`, to decide for each sender or channel.
- Keeping an `ask_question` open through a new message. A task already does this.
- Recording the sender on each tool call's trace beside the turn's caller.
- A per-session access list. Channels still decide who reaches a session.
