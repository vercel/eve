# Durable boundary compatibility tests

Durable data can outlive the code that wrote it. A session might start on one
eve version, pause for days, and resume after several deployments. These tests
give us a repeatable way to prove that current code still understands the data
already in the wild.

## How it works

A compatibility test starts with a historical producer, not a hand-written
approximation of its output. The producer runs the pinned old implementation
and returns the value it wrote at the durable boundary.

The compatibility harness then runs that value through the current boundary:

```text
historical producer
  -> JSON transport
  -> current hydrate
  -> current migration
  -> current serialize
  -> repeat the same pass
  -> simulate rollback
  -> replay after rollback
```

The repeated pass must serialize to exactly the same value. This catches
migrations that appear to work once but keep changing durable state every time a
worker resumes.

Rollback testing adds a sacrificial mutation and verifies that it is discarded.
It also checks that every declared compatibility key survives and that unrelated
original state is unchanged. This prevents a test from passing when its rollback
function simply returns the interrupted value.

Domain assertions are still required. A migration can reach a stable but wrong
result, so each consumer must assert the behavior it cares about: IDs, admission,
capture flags, versions, or anything else with user-visible meaning.

## Capturing snapshots

Run:

```bash
pnpm --filter eve capture:durable-compatibility
```

This executes every `durable-compatibility` scenario with Vitest snapshot updates
enabled. For session instrumentation, isolated child processes load the pinned
`eve@0.44.4` and `eve@0.45.0` packages. Isolation matters because context keys
use a process-global registry; loading old and current implementations together
would let the historical codecs replace the current ones.

The checked-in snapshot shows three useful stages:

- `source`: what the historical producer emitted
- `migrated`: what current code persisted after migration
- `rollback`: what survived cancellation rollback

Snapshot updates do not bypass semantic assertions. If migration reevaluates a
frozen policy, changes a trace ID, widens content capture, or drops a required
alias, capture fails before the new snapshot can be accepted.

Normal verification never updates snapshots:

```bash
pnpm --filter eve test:durable-compatibility
```

## Adding another boundary

1. Name the scenario `*-durable-compatibility.scenario.test.ts` so the shared
   commands discover it.
2. Provide a `capture` callback backed by the real historical producer. Use
   `serialized` only when executable historical code is unavailable.
3. Provide the current `hydrate`, `migrate`, and `serialize` operations.
4. Add an `assert` callback for the boundary's semantic contract.
5. Add rollback handling and list every key that must survive, when applicable.
6. Run the capture command once, inspect the generated source and migrated
   snapshots, then run the verification command without `-u`.

Keep the harness test-only. Production migrations should continue using their
own explicit, versioned code; this framework verifies those migrations rather
than replacing them.
