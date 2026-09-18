# State delta fuzz prototype

The generated mutation property reproduces PR #3507's key-order loss through
Workflow's real serializer; it intentionally fails until the production bug is fixed.

The prototype is based on `af3f75377f6677aeff79dc131e75f224db447211`. It adds
`fast-check` 4.10.1 as a development dependency and leaves production code unchanged.

## Run

In a built checkout with dependencies installed, from the repository root:

```sh
pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/execution/session/turn-step-delta.fuzz.integration.test.ts
```

Defaults are 200 cases with seed 3507. Override `EVE_FUZZ_RUNS` and
`EVE_FUZZ_SEED` to explore other cases. Replay the minimized failure with:

```sh
EVE_FUZZ_SEED=3507 \
EVE_FUZZ_PATH='1:2:1:1:3:4:4:3:3:4:6:5:6:6:6:6:0:3' \
pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/execution/session/turn-step-delta.fuzz.integration.test.ts -t 'matches full-result'
```

Use the matching test-name filter when replaying a path: paths belong to one
property and depend on its generator and fast-check version.

## What it checks

Each case starts with a small JSON-like tree and applies up to 12 operations:
set, delete, delete-and-reinsert, reverse property order, append, truncate, and
replace an array element. Nested values are generated up to two container levels.

For each operation, the test hydrates a separate step input, captures its state
before mutation, and compares a serialized full result against an applied,
serialized `DurableStepDelta`. The comparison checks primitive values, ordered
own keys, array type, and array length. It also verifies that applying a delta
leaves its checkpoint untouched and that replaying all recorded deltas reproduces
every expected intermediate result. Generated inputs remain unmodified so shrinking
can replay them reliably.

This first prototype covers JSON-like trees. It does not claim coverage for aliases,
cycles, rich values, cancellation branches, or actual workflow scheduling. Keys are
bounded to six characters because Workflow rejects own `__proto__` keys before
delta creation. Comparator checks separately prove that it detects reordered keys,
missing versus undefined properties, array holes, and array-versus-object differences.

## Observed result

The mutation property failed on generated case 2 and shrank 17 times to:

```json
[{ "entries": { ":": 0, " ": [] }, "items": [] }, [{ "kind": "reverse" }]]
```

Full-result keys are `[" ", ":"]`; delta-result keys remain `[":", " "]`.
Replaying the seed and path reproduced that exact failure without further shrinking.
The 200 generated append sequences and four comparator checks passed. Package
typechecking, focused lint/format checks, and frozen-lockfile validation also passed.

Keep this as a normal assertion, not `it.fails`: after a production fix it should
pass, and any future counterexample should fail the suite.
