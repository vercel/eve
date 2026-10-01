---
issue: https://github.com/vercel/eve/issues/4132
status: proposed
last_updated: "2026-10-01"
---

# Sign-ins and tool approvals hold the turn

## Problem

A turn that asks a question through `ctx.ask`, or waits on a task, stays
open: the stream emits `turn.waiting`, and the same turn resumes once the
answer arrives. A turn that needs a connection sign-in or a tool approval
does the opposite. It emits `turn.completed` and `session.waiting`, and the
callback or approval later starts a new turn. The same "waiting on a person"
state has two lifecycles, sign-in and approval prompts outlive the turn that
needed them, and nothing ends a prompt nobody answers.

## Behavior

A sign-in (`authorization.required`) or tool approval (`input.requested`
for a `tool-approval`) the turn itself raises holds the turn, exactly as a
task or `ctx.ask` does:

```
turn.started
  … tool call needs sign-in or approval …
authorization.required | input.requested
turn.waiting                 ← on: "input"; same turnId
  … the person acts …
authorization.completed | input.resolved
step.started                 ← same turnId, no new turn.started
  …
turn.completed
session.waiting
```

While the turn is held:

| Input                                                      | Result                                                                                                                                                                                                                           |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in callback for the held attempt                      | Resumes the held turn.                                                                                                                                                                                                           |
| Approval answer (any responder the policy accepts)         | Resumes the held turn.                                                                                                                                                                                                           |
| Approval answer the response policy refuses                | Keeps the turn held and emits `turn.waiting` again, so the responder's request ends; another responder can still answer.                                                                                                         |
| Message from the turn's own person                         | Steers the turn and cancels the held request. A sign-in reports `authorization.completed` with `outcome: "declined"`; an approval resolves as `ignored`. The model reads the message with a note that the request was cancelled. |
| Message from anyone else                                   | Queues until the held turn ends, as it does behind a task.                                                                                                                                                                       |
| `session.cancel()` (for example a Slack **Cancel** button) | Cancels the turn and its held sign-ins (`authorization.completed`, `declined`).                                                                                                                                                  |

There is no timeout: an answer, a steering message, or a cancel ends the
hold, as with tasks.

Sign-ins raised while settling an approval response policy (`candidateId`)
also hold the turn they run in.

## Where a response ends

Every `turn.waiting` says what the turn waits on: `on: "input"` when a
person must act (a sign-in, approval, or question, including ones proxied from
a workflow tool or subagent), and `on: "tasks"` when work the turn started is
still running. `"input"` wins when both apply. Clients stop reading at
`"input"`, which matters when the request was read earlier, such as a refused
approval answer or a resumed stream. Other human-in-the-loop paths, such as
the session-limit prompt, adopt `"input"` when they move to holding the turn.

## Channels

Slack's private sign-in prompt and approval cards say the agent is paused
until the person acts, and the turn's own sign-in prompt has a **Cancel** button
that cancels the held turn and removes the prompt. A responder's sign-in for
an approval has no Cancel button, since it belongs to the approval rather
than a turn the responder could cancel.

## Out of scope

- Approvals pending when a turn is cancelled stay answerable, as before.
- Sign-ins and questions inside tasks and workflow tools already hold the
  turn and are unchanged.
