# Task eval transitions

## Remote callback routing regression

`task.input.answer.accepted-complete.remote.eval.ts` reuses the existing remote
HITL and completion round trip to cover the callback-prefix bug from
[eve #3047](https://github.com/vercel/eve/pull/3047). The fixture's `vercel.json`
sets the service route to `/eve/v1`.

The eval uses event assertions labeled "remote input callback reaches the parent"
and "remote completion callback reaches the parent". It also logs which delivery
it is waiting for. These assertions check the live round trip through the public
eval APIs; they do not inspect the generated callback URL.

The [build scenario](../../../../packages/eve/src/internal/nitro/host/build-application.scenario.test.ts)
separately checks that this service route adds no extra public prefix. Local and
Postgres runs exercise the remote round trip, but only the Vercel build exercises
service-prefix inference.

## Transition declarations

These evals are executable evidence for the background-task contract. They do
not define that contract.

When sources disagree, use this precedence:

1. `research/tools-as-tasks.md` for settled externally observable intent.
2. Public tool and protocol contracts.
3. `packages/eve/src/tasks/types.ts` and `transitions.ts` for executable
   lifecycle semantics.
4. Evals and lower-level implementation as evidence.

Every `*.eval.ts` case uses `defineTaskEval` and declares exactly one primary
transition. The canonical specification in `task-transition.ts` supplies its
pre-state, semantic input, guards, outcome, post-state, events, and side
effects. `setup` records prerequisite transitions but does not claim coverage
for them.

Transition anchors follow:

```text
<machine>.<entity>.<input>.<outcome>[-<guard>]
```

Anchors describe semantics, never document order. Scenario variants such as
local and remote transport share an anchor and use a filename suffix plus the
`dimensions` declaration. Presentation labels such as A2 or C7 are not stable
identity.

State is factored across lifecycle, outstanding input, executor binding,
dispatch admission, agent occupancy, parent phase, transport, ownership, and
usage. A scenario declares only dimensions relevant to its primary transition;
it must not enumerate their Cartesian product.

`pnpm validate:transitions` enforces declaration and filename identity. The
fixture `typecheck` command runs that validation before building and checking
TypeScript.
