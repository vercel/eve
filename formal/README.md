# Formal models

Lean 4 models of parts of the eve session machine, with proofs of what they guarantee. Lean
checks each proof when it builds, for every state the model can be in.

## `Eve/StepDecision.lean`

Models `decideStep` (`packages/eve/src/execution/session/step-decision.ts`), which decides what
happens after a turn step from the state the step left. It proves:

- every pause has something that can end it, and only an open turn pauses;
- the session's end always wins, and a step's report that the model runs again is never dropped;
- a turn that waits on its own person waits on them, whatever else it waits on;
- the session parks with a turn open only when a step left the turn with nothing to wake it;
- the decision equals the resolver it replaced, on every state a step could leave
  (`refines_previous`), with the guarantees each step made stated in `Reported`;
- the dev-mode check against `waiting(view, turnId)` stays silent whenever the tables show what
  `TablesAgree` states (`agrees_with_tables`), and the `example`s list states where the tables
  legitimately show something else.

The TypeScript and the model stay in step through a table. `lake exe eve-formal` prints the
model's decision for every state; `packages/eve/src/execution/session/step-decision.lean-table.ts`
is that output, and `step-decision.test.ts` checks the TypeScript against each row. The Formal
model workflow rebuilds the proofs, rechecks them with `leanchecker`, and fails if the committed
table differs from the model's output.

## Working on the models

Install [elan](https://github.com/leanprover/elan), which installs the Lean version in
`lean-toolchain`. Then, from this directory:

```sh
lake build                     # check every proof
lake exe eve-formal > ../packages/eve/src/execution/session/step-decision.lean-table.ts
```

Regenerate the table whenever the model changes, and change the model and `decideStep` together.
