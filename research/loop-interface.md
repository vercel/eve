---
issue: https://github.com/vercel/eve/issues/512
last_updated: "2026-07-21"
status: implemented
---

# Decouple eve's agent loop from durable execution

## Decision

Select one artifact-bound `LoopDriver` when the host constructs a `Runtime`.
Every implementation then runs the same two eve-owned programs:

```text
host route or scheduled task
  -> resolveLoopDriver()                 select workflow | inline | temporal once
     -> Runtime                          public session/input/stream surface
        -> runSession(SessionBackend)    session lifetime and delivery
           -> runTurn(TurnBackend)       one logical turn
              -> next()                  one generation and its immediate requests
```

`runSession` and `runTurn` are nested programs, not competing implementations.
The only implementation branches are the selected driver's `SessionBackend`
and `TurnBackend` adapters.

Workflow is the explicit default. Inline and Temporal are experimental local
implementations selected with `eve dev --loop <implementation>` or `EVE_LOOP`.

## Ownership

- [`driver.ts`](../packages/eve/src/internal/loops/driver.ts) is the sole
  implementation selector. It binds the driver to the compiled-artifact
  generation so child work cannot silently choose a different implementation.
- [`session-program.ts`](../packages/eve/src/core/session-program.ts) owns the
  sequence of turns: start a turn, finish a completed session, or park a
  suspended session until the next delivery.
- [`turn-program.ts`](../packages/eve/src/core/turn-program.ts) owns the sequence
  of steps within one turn: advance, checkpoint, and settle.
- [`types.ts`](../packages/eve/src/core/types.ts) keeps `SessionBackend` and
  `TurnBackend` as sibling ports. Session mechanics cannot generate, and turn
  mechanics cannot receive public input or finalize a session.
- Engine adapters own persistence, retries, delivery queues, child-result
  demultiplexing, stream transport, and engine lifecycle. Adapter queue drains
  may loop, but adapters do not start successive domain turns or steps.

The Workflow adapter lives under
[`internal/loops/workflow`](../packages/eve/src/internal/loops/workflow), next
to the inline and Temporal adapters under
[`internal/loops`](../packages/eve/src/internal/loops).

## Preserved semantics

- A conversation reply parks the session; a task completion returns a terminal
  result.
- A suspended turn carries its complete reason across the session boundary:
  cancellation, pending authorization, or a pending input batch.
- Workflow continuation claims, cancellation settlement, continuation-token
  rekeying, descendant routing, callback publication, and close hooks remain in
  the Workflow session adapter.
- Each turn receives the latest compiled artifacts selected for that session's
  implementation.
- Workflow remains the default when no loop implementation is configured.

## Deliberate implementation limits

- Inline state and events are process-local and non-durable.
- Temporal requires a local Worker and currently supports root conversation
  sessions only; its Worker/testing packages are optional peers, and delegated
  nodes and turn cancellation are not implemented.
- Inline and Temporal are rejected in Vercel Functions. Production Vercel
  execution continues to use Workflow.

These limits are explicit adapter behavior. They do not introduce alternate
session or turn programs.

## Historical evidence

The original three-adapter experiment proved that the program/adapter split was
feasible before it entered the production runtime. Its source and detailed test
record are preserved in commit
[`789784b2`](https://github.com/vercel/eve/tree/789784b2b79fd600b0825aa0f0a1bddb58b39abc/packages/eve/src/internal/testing/loop-prototype)
and summarized in
[`loop-interface-prototype-results.md`](./loop-interface-prototype-results.md).
The production migration removed that duplicate prototype so the repository has
one session program and one turn program.
