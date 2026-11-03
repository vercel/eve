---
issue: TBD
status: proposed
last_updated: "2026-11-03"
---

# Filter which open requests `awaitingInput()` accepts

Let `awaitingInput()` take an interaction filter, so an eval can require that a
run parked only on the kinds of input it expects, such as approvals.

## Motivation

An eval of an unattended run often has three valid endings. Consider an agent
that reads untrusted content, such as a public issue, which tells it to call a
tool that needs approval:

1. The turn completes: the agent ignored the instruction.
2. The turn parks only on approvals: the agent requested the action, and the
   eval's scored checks inspect the pending calls to decide whether it was the
   one the content asked for.
3. The turn parks on anything else (a question, a sign-in, a budget request),
   or it fails: the case didn't run, and it must not count as ending 1.

Branching on `turn.status` separates ending 1 from the others, but no assertion
can express ending 2:

- [`awaitingInput()`](../packages/eve/src/evals/assertions/run.ts) passes on any
  park, because `derived.parked` is one boolean.
- `session.requireInteraction({ kind: "approval" })` requires exactly one open
  request, so it fails when the agent requests two approvals in one turn.

Evals hand-roll the rule today: `turn.expectOk()`, then a check that every
entry in `turn.interactions` is an approval. Each eval rebuilds it, and the
rule stays out of eve's assertion report.

## Authoring contract

`awaitingInput(filter?)` accepts `EveEvalInteractionMatchOptions`, the filter
`requireInteraction` already takes (`kind`, `toolName`, `input`, `prompt`,
`display`, `optionIds`):

```ts
if (turn.status === "awaiting-input") turn.awaitingInput({ kind: "approval" });
else turn.succeeded();

t.awaitingInput({ kind: "approval", toolName: "deploy" });
```

- The assertion passes when the scope parked and **every** open request
  matches `filter`. It fails when the scope didn't park, or when any open
  request doesn't match.
- A failed run or an error event fails it first, as today.
- `awaitingInput()` and `awaitingInput({})` behave as today.
- Failure messages list each open request that didn't match, with its `kind`,
  tool name, `interactionId`, and `taskId`, so a report shows which session
  stalled, including requests raised by a subagent.
- It works on turn, session, and eval scopes, like the other scoped assertions.

## Open requests

An open request is one whose status is `open` at the end of the scope:

- **Turn scope:** the session's open requests, as `openInteractions(view)`
  reports them. A request left open by an earlier turn counts.
- **Session and eval scope:** the open requests of every session in the scope.
  A session that completed contributes none, so at eval scope a completed
  session A and a session B parked on an approval pass
  `awaitingInput({ kind: "approval" })`.

Assertions don't see the session view, so `EveEvalDerivedFacts` gains a field
next to `parked`:

```ts
/** Requests still open at the end of the scope, from every session in it. */
readonly openInteractions: readonly Interaction[];
```

At eval scope, eve already derives each session's facts once from its merged
stream, so the field holds each open request once.

## Scope

- An OR across filters, such as an approval for tool A or tool B, is out of
  scope. Accepting an array of filters is the natural extension.
- `succeeded()` is unchanged. A run that parked doesn't succeed, whatever it
  parked on.
- `EveEvalInteractionMatchOptions.kind` also documents `sign-in`, which the
  type already accepts.

## Validation

- Unit tests for runs parked on one approval, two approvals, a question, a
  sign-in, a budget request, and an approval plus a question; a `toolName`
  filter that rejects another tool's approval; a run that didn't park; a failed
  run and an error event, with and without a filter; a request left open by an
  earlier turn; and an eval with one completed session and one parked on an
  approval.
- The mock-model `gated-deploy.approval` eval in the `agent-workflow-tools`
  fixture asserts `awaitingInput({ kind: "approval", toolName: "gated_deploy" })`
  on its parked turn, so the deterministic world suites cover it.
- `docs/evals/assertions.mdx` documents the option, the open-request
  definition, and one example. The change ships with a `minor` changeset.
