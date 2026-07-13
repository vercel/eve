---
issue: TBD
status: in-review
last_updated: "2026-07-13"
---

# Dev revision isolation

## Summary

eve already reloads ordinary authored edits during local development. The remaining failures occur
when one reload changes several independently mutable surfaces: compiled artifacts, runtime source,
Nitro inputs, routes, workers, and Workflow state. A removal or failed structural rebuild can leave
those surfaces on different versions, break a previously healthy server, reset an admitted request,
or delete files still needed by a worker or durable run.

The target is one immutable authored revision and one atomic promotion boundary. New behavior stays
private until every required artifact and worker is ready. A failed candidate leaves the complete
last-good revision active.

## Ownership model

```text
authored edit
    │
    ▼
immutable revision ── runtime-only ─────────► publish revision pointer
    │
    └── structural ─► ready Nitro candidate ─► atomically swap pointer, routes, and worker

stable parent server
    ├── owns the listener and dev control endpoints
    ├── leases one worker and revision per admitted request
    └── retires old workers and revisions only after their references are released
```

A revision contains the complete executable authored dependency closure. Nitro host inputs retained
for the server lifetime live outside the prunable revision store. Runtime-only edits—tools,
connections, skills, instructions, and similar behavior—continue to reload without replacing the
worker. Changes to host structure, including channel topology and instrumentation, replace the
worker only after a candidate reports ready.

Durable Workflow runs retain the revision they started with. Pruning removes a revision only when
it is not active, a candidate, last-good, leased by a request or worker, or referenced by a durable
run. Until those references exist, revisions are retained conservatively.

## Delivery

1. **Production build isolation:** give each build private compiler, host, Nitro, Workflow, and
   output workspaces; serialize only final publication. This is the current PR.
2. **Immutable revisions:** materialize complete, path-independent authored revisions without
   changing worker ownership.
3. **Parent worker transport:** add readiness, request and revision leases, cancellation, trusted
   client metadata, and bounded shutdown behind a stable listener.
4. **Transactional dev rebuilds:** connect the watcher, revision pointer, routes, and candidate
   worker through one promotion coordinator with complete rollback.
5. **Durable Workflow and pruning:** resolve existing runs from their recorded revision and prune
   only from explicit references.

Each stage remains independently valid and does not expose a partially connected lifecycle.

## Result

- Concurrent production builds cannot interfere with each other or a running dev server.
- Removing an authored tool or dependency cannot leave a stale Nitro import behind.
- A failed compile, bundle, worker start, route change, or pointer publication keeps the previous
  server fully usable.
- Structural reloads do not reset admitted requests or make parent-owned dev endpoints unavailable.
- Channel changes preserve the route Nitro selected, including overlapping routes.
- Active streams release their worker and revision ownership on completion, failure, cancellation,
  or disconnect; shutdown does not wait forever on a worker it has not stopped.
- Advancing and pruning a runtime revision cannot remove Nitro inputs retained by the dev server.
- Existing Workflow runs continue with their original tools and instructions after newer edits and
  pruning, while new runs use the promoted revision.

The gray-matter vendoring change is independent of this lifecycle work.
