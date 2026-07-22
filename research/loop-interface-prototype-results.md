---
issue: https://github.com/vercel/eve/issues/512
last_updated: "2026-07-21"
status: implemented
---

# Loop backend prototype results

This is the archived evidence record for the experiment that preceded the
production migration in [`loop-interface.md`](./loop-interface.md). The
prototype was removed after its shared programs and three adapters were
integrated into the production code path; keeping both copies would recreate
the ownership ambiguity the migration resolves.

The exact prototype source is preserved at commit
[`789784b2`](https://github.com/vercel/eve/tree/789784b2b79fd600b0825aa0f0a1bddb58b39abc/packages/eve/src/internal/testing/loop-prototype).

## Evidence captured before removal

- One unchanged nine-test conformance suite passed against inline, Workflow,
  and Temporal adapters.
- Focused unit tests passed 39/39.
- The Workflow local harness passed 10/10 tests.
- A real local Temporal Server and Worker passed 10/10 tests and history
  inspection observed Activities, Child Workflows, delivery signals,
  checkpoint signals, and checkpoint acknowledgement.
- Workspace formatting, lint, and typecheck passed for the prototype branch.

Those receipts established adapter feasibility. They did not establish the
production behaviors later migrated into the Workflow session adapter:
continuation-token claims and rekeying, retired-hook draining, public stream
publication, callbacks, scheduled tasks, build-time packaging, or host
selection.

## Production replacement

The current verification target is no longer prototype conformance. It is the
single production path:

- [`runSession`](../packages/eve/src/core/session-program.ts) and
  [`runTurn`](../packages/eve/src/core/turn-program.ts) are the only domain
  loops.
- [`resolveLoopDriver`](../packages/eve/src/internal/loops/driver.ts) is the only
  implementation selector.
- Workflow, inline, and Temporal implement the two engine ports without owning
  a second session or turn loop.

The current tests beside those files, plus the Workflow integration and
Temporal scenario suites, are the authoritative evidence for the production
implementation.
