---
issue: "TBD (maintainer-requested implementation; no matching issue found)"
status: implemented
last_updated: "2026-10-26"
---

# Tool stubs that end the turn

## Problem

An eval that grades a decision, such as which specialist an agent delegates to or the arguments it
sends a tool, has no clean way to stop once that call returns. The model keeps going: it reads the
stubbed result, answers, or calls more tools. Cancelling from the eval client races the next model
step and ends the turn `cancelled`.

## Authoring API

A `response` outcome may set `endsTurn: true`:

```ts
await t.session({
  stubs: [
    { id: "slack", tool: "slack", outcome: { response: "No thread found.", endsTurn: true } },
  ],
});
```

- The call that receives that outcome ends the turn once it is the call's result. The turn
  completes without a final reply, and the model is not called again.
- The model is not told. Unlike a tool's own `endsTurn`, no sentence is added to the tool's
  description.
- `endsTurn` is only accepted beside `response`. With `outcomes`, each call ends the turn or not
  by the outcome it receives, so `[{ throw }, { response, endsTurn: true }]` lets the agent
  recover once and then stops.
- It is rejected at session creation on a subagent's tool (`researcher/list_tasks`): a delegated
  session must reply to its caller. Stub the subagent (`researcher`) instead.
- Like tool `endsTurn`, it does not apply in delegated sessions or on structured-output turns.
- It travels with the session's `stubs`, so the existing `allowToolStubs` grant governs it.

## Semantics

The turn ends after the model's step when every call in it got an `endsTurn` response or is a
call to an `endsTurn` tool, and all succeeded. Calls that run in the step are decided at the
step's end, by the same rule as tool `endsTurn`. When the step also made workflow calls, which
include agents and task tools, the session decides once their results are in, before its next
model call: while only tasks those calls started work, it waits for them instead of calling the
model with their receipts, then settles. Any other task that works or has a result the model
hasn't read, or a person's message arriving first, lets the model run.

## Boundaries

One record holds the decision for calls whose results arrive later: the turn's ending call IDs in
session state.

```text
in-step call ─ stub answers in the step ─▶ step's end decides (with tool endsTurn)
                                    └─────▶ ending call IDs, when the step parks
workflow call ─ session asks playback after dispatch ─▶ ending call IDs (session state, per turn)
next model step ─ every call of the last step ending? ─▶ settle / wait for its tasks / call model
```

- For a workflow call that ran, the session asks playback for its outcome only when the tool's
  stubs can end the turn. Playback records outcomes by stub call ID, so the run's body gets the
  same one, whichever asks first. Refused calls consume no outcome. No message between the run
  and the session changes.
- Earlier saved sessions have no record and keep their behavior.
