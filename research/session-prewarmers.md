---
issue: "Maintainer-requested implementation"
status: in-progress
last_updated: "2026-10-23"
---

# Session prewarmers

Nothing session-scoped may delay the model call. A turn that needs the sandbox still pays to
start it, and to write files that dynamic resolvers return at `turn.started`. Session
prewarmers start that work in the background as early as possible. Whatever uses the result
waits only for the rest of the race.

## Semantics (implemented)

Prewarmers run at two points:

- `"session"`: a session created without a message runs a prewarm step beside its wait for that
  message.
- `"turn"`: the first model call of each durable turn step starts them before `turn.started`.
  Control turns (`clear`, `compact`) skip them.

A prewarmer starts work and returns. Framework providers own the work: consumers wait for it,
and the provider settles it before its scope commits. The model call never waits for it, so a
model-only turn pays nothing until its step commits.

The sandbox access has an ordered background queue:

```ts
access.prepare(); // open in the background
access.prepare(async (open) => {
  /* work; call open() only if needed */
});
access.resumeRecorded(); // resume only; never starts a sandbox
await access.get(); // waits for the open and all queued work: the last mile
await access.open(); // the connection only, for attachment staging and hydration
```

- Dynamic skill files go through the queue instead of waiting for `get()`. Unchanged packages
  never open the sandbox.
- Background work is best effort. A failed job is retried once before later work runs, so work
  never lands out of order, then logged and dropped. Its owner must leave a record that redoes
  it: a changed skill package is forgotten synchronously at dispatch, so the next dispatch
  rewrites it. The step commit waits for the queue but never fails on it, so a failed write
  never re-runs a model call or its tools.
- In the `"session"` phase the sandbox prewarmer opens the sandbox. In the `"turn"` phase it
  only resumes a sandbox the session recorded, and leaves a gone one to `get()`. Every agent
  has a sandbox, so a turn never starts one speculatively; queued work starts one when needed.
- Attachment staging and hydration use `open()`, so they never wait behind skill writes.

A first message never waits for the prewarm step. The step runs beside the wait. Its recorded
state is applied only while the owner still waits for its first input and no other session step
has run. Otherwise it is dropped. Provider `start()` is a documented cross-process upsert, so a
turn that opens the sandbox meanwhile reaches the same one; the selector may run twice, which
its existing idempotency rule covers. The step keeps context changes the selector makes, such
as `defineState()` updates. Session end waits for the step, so cleanup finds whatever it
started. A prewarm handoff is skipped while the step runs, so a successor never ends the session and
cleans up before a start the old owner still has in flight.

```mermaid
flowchart LR
  Create["create without a message"] --> Prewarm["prewarm step: open in background"]
  Create --> Wait["wait for first message"]
  Prewarm -. "state applied only if still waiting" .-> Wait
  Wait --> Turn["turn: resume in background, queue skill files"]
  Turn --> Model["model call starts immediately"]
  Turn --> Tool["tool: get() waits for the rest"]
```

## Internal contract

```ts
type SessionPrewarmPhase = "session" | "turn";

interface SessionPrewarmer {
  readonly name: string;
  start(ctx: ContextContainer, phase: SessionPrewarmPhase): void;
}
```

The registry sits next to the framework provider list. Adding a prewarmer needs no workflow,
checkpoint, or protocol change: it hands work to a provider, as the sandbox prewarmer hands it
to the access queue.

## Next steps (not implemented)

- Other turn-start sandbox work, such as staging inbound attachments, can use the same queue.
- An authored API: a callback that starts work in the same scope and hands consumers a value
  to wait on, rather than a side effect nobody can join.
- Turns of sessions created with a message do not start the sandbox unless work needs it. Any
  eager start for those turns needs an agent-level policy, because it costs a sandbox for every
  chat-only agent.
