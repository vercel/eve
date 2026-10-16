---
issue: "None (maintainer-requested research)"
status: implemented on stack #4696
last_updated: "2026-10-13"
---

# Session events as one tree

v27 gives every entity a lifecycle: it's introduced, maybe updated, and closed
([`session-event-lifecycle.md`](./session-event-lifecycle.md)). This doc is about the structure
those lifecycles share: one ownership tree, which the stack's code reads in one place.

## Summary

- **The entities form one ownership tree.** `parentOf` in `protocol/session-projection/tree.ts`
  states each family's owner once. Selectors, retention, closure, scopes, and the stream checker
  read it, instead of each walking "what's above this?" family by family. Before, they
  disagreed: the checker's idea of what a turn holds differed from the closer's.
- **An owner's end closes what it holds.** `harness/session-machine/cascade.ts` appends the
  closing facts in the same commit, leaves first. Transitions write only the owner's own end.
- **The writer stamps every fact's scope** from the tree.
- **The fold is table-driven.** Lifecycle facts fold by their catalog role; only what a fact
  changes beyond its own row is code.

The tree landed in PR 1 (#4564) and the cascade in PR 2 (#4567). PR 8 (#4693) moved the cascade
and the scopes into the writer.

## The rules

These are what 1.0 promises. They describe the stream, so readers can rely on them, and the code
follows them by construction.

1. **Every entity has at most one owner,** named by the fact that introduces it:

   | Entity         | Owner                                                                                                                                                                |
   | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | turn, task     | the session                                                                                                                                                          |
   | model run      | its turn or context change (`owner`)                                                                                                                                 |
   | content part   | its model run                                                                                                                                                        |
   | call           | the task serving it, once `call.started` names one; otherwise the run that made it while the run is open, then the run's owner once it completes; or its parent call |
   | interaction    | what it's about (`subject`): a call, turn, task, or response                                                                                                         |
   | response       | its interaction                                                                                                                                                      |
   | context change | its turn, or the session                                                                                                                                             |
   | delivery       | the session, until a turn consumes it                                                                                                                                |
   | child session  | the call or task that opened it                                                                                                                                      |

   Ownership changes only by a fact that says so (`call.started {taskId}`,
   `delivery.consumed {turnId}`), and when a run completes, which hands the calls it made on to
   its owner.

2. **An owner's end closes everything still open under it, in the same commit, leaves first.**
   Each family has one outcome for "its owner was cut" and one for "its owner was superseded by
   a retry":

   | Family      | Owner cut                                                 | Owner superseded |
   | ----------- | --------------------------------------------------------- | ---------------- |
   | call        | `interrupted`                                             | `abandoned`      |
   | model run   | `interrupted`                                             | `abandoned`      |
   | interaction | `interrupted`                                             | `abandoned`      |
   | response    | `withdrawn`                                               | `abandoned`      |
   | task        | `cancelled`                                               | `cancelled`      |
   | turn        | `cancelled`                                               | `cancelled`      |
   | change      | `interrupted`                                             | `interrupted`    |
   | delivery    | `handled`, after its turn; `failed` when the session ends |                  |

   What a commit closes explicitly keeps its own outcome: `withdrawn` stays for a question its
   asker or a steering message took back.

3. **A fact's `scope` is its owners from the tree:** the turn, task, run, and change at or above
   the entity it's about. A call also names the run that made it, and that run's turn.

4. **The writer applies rules 2 and 3.** No producer builds closing facts or scopes itself.

Closing facts carry a reason from what ended: `session-ended`, `turn-ended` (or
`turn-cancelled`, `turn-failed`), `model-call-retried`, `steered`, `task-ended`,
`interaction-<outcome>`, and `context-change-failed`.

Two outcomes follow from the rules rather than from each path:

- **Work under a failed turn is `interrupted`, not `failed`.** Only what failed fails.
- **A question about a call closes when the call ends,** as `interrupted`. Before, a cancelled
  `serve()` stretch's question stayed open until its run withdrew it.

**Provenance isn't ownership.** Which run made a call, and so which turn it's attributed to,
doesn't change when a task serves it. `callTurn` and `callRun` read provenance.

## One taxonomy, inside and out

The first v27 PRs changed the wire but kept v26's model on both sides of it. The engine built
`InputRequest`s and converted them to facts, and readers converted rows back into
`InputRequest`s. The stack makes the interaction family the model everywhere:

- **The engine builds interaction requests** and keeps interaction IDs. An approval stores its
  call, and the budget prompt asks about its turn rather than a made-up tool call.
- **An answer is `{interactionId, optionId?, text?}`** everywhere: client, channel, MCP,
  `eve invoke`, and the engine.
- **Readers read rows:** `askedInteraction` gives the request's own fields, its ID, and the call
  it asks about.
- **A child relays its own interaction facts,** keyed by its own IDs: the requests one commit
  opened, together, or one other fact. The child decides all of them, and the serving session
  mirrors them. Relaying fact by fact would ask a child's two approvals in two parent commits,
  so a person would see two pauses for one question set.

Calls (`RuntimeActionRequest` and `RuntimeActionResult` to and from call facts) are the
remaining family with converters both ways. Instrumentation uses the stream's event names
(#4695), with payload shapes of its own.

Open strings hide stale comparisons: `InteractionRequest.kind` is open on the wire, so a
leftover `=== "tool-approval"` would compile and never match. TypeScript keeps kinds closed for
that reason, and readers keep a default branch.

## Not planned

- **A shared owner field on the wire.** Every introducing fact could name its owner as `owner`,
  so a generic reader could draw the tree without family knowledge. Rule 1's ownership changes
  still need code, so the gain is small. Not worth it unless external tooling needs it.
- **A shared outcome core.** Rule 2's table could be uniform if every family had `interrupted`
  and `abandoned`. It's one small table, so not worth changing the vocabulary.
