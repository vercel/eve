# Formal models

Lean 4 models of parts of the eve session machine, with proofs of what they guarantee. Lean
checks each proof when it builds, for every state the model can be in.

## `Eve/StepDecision.lean`

Models `decideStep` (`packages/eve/src/execution/session/step-decision.ts`), which decides what
follows a step from the session's state alone. It proves:

- every pause has something that can end it, only an open turn pauses, and no pause outlives
  its cause;
- the session's end always wins, and the turn runs only with input to read, so it never spins;
- what a turn waits on doesn't depend on anything that ranks below it;
- no lost wake-up: every arrival that changes a waiting turn's decision is one that
  `SessionExecution.resume` wakes for;
- the session parks with a turn open only when a step left nothing to wake it, and the dev
  check always flags that;
- the decision equals the resolver it replaced, which read what each step reported, on every
  state a step could leave (`refines_previous`);
- the dev check against `waiting(view, turnId)` stays silent whenever the tables show what
  `TablesAgree` states.

The TypeScript and the model stay in step through a table. `lake exe eve-formal` prints the
model's decision for every state; `packages/eve/src/execution/session/step-decision.lean-table.ts`
is that output, and `step-decision.test.ts` checks the TypeScript against each row.

## Working on the models

Install [elan](https://github.com/leanprover/elan), which installs the Lean version in
`lean-toolchain`. Then, from this directory:

```sh
lake build                     # check every proof
lake env leanchecker Eve       # recheck them with the kernel's independent checker
lake exe eve-formal > ../packages/eve/src/execution/session/step-decision.lean-table.ts
```

Regenerate the table whenever the model changes, and change the model and `decideStep` together.
