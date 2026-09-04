# Task eval transitions

## Remote callback routing regression

`task.input.answer.accepted-complete.remote.eval.ts` reuses the existing remote
HITL and completion round trip to cover the callback-prefix bug from
[eve #3047](https://github.com/vercel/eve/pull/3047). The fixture's `vercel.json`
sets the service route to `/eve/v1`.

Before deploying this fixture, Vercel CI runs `scripts/assert-callback-route.mjs`
against the built workflow function configuration. It asserts the callback path
is `/eve/v1/callback/<token>`; the broken build produced
`/eve/v1/eve/v1/callback/<token>`. A mismatch fails immediately with both paths,
before running the existing remote eval. Local and Postgres runs exercise the
remote round trip, but only the Vercel build exercises service-prefix inference.

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
