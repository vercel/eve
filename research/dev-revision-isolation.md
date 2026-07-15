---
issue: TBD
status: in-review
last_updated: "2026-07-13"
---

# Dev generation isolation

## Summary

eve already reloads most authored edits during local development. Changing a tool body,
instructions, or a connection usually works without restarting the server. The remaining problems
appear when an edit removes something, changes server structure, fails partway through, or overlaps
with work that is already running.

One rebuild currently updates several independent pieces of state: compiled artifacts, copied
runtime source, Nitro build inputs, routes, the running worker, and Workflow data. Those pieces do
not share one commit point. A rebuild can therefore publish some new state before another step
fails, leaving the server with a mixture of old and new behavior.

The goal is to prepare one complete immutable generation of an agent privately and expose it only
after everything needed to run it is ready. New turns use the latest successfully promoted
generation. A turn already in progress stays on the generation selected when its child Workflow
started, including queue retries and resumptions, but a parked session is not pinned to historical
authored code.

## Problems being solved

### Builds share mutable application paths

Production builds have historically written compiler, host, Nitro, Workflow, and output artifacts
into application-owned directories also used by other builds or `eve dev`. Concurrent builds can
consume each other's intermediate files, and a failed build can disturb a healthy dev server or
replace part of the last successful output.

Each production build needs private working directories. Only the final, completed output should be
published to the application, and that short publication step must preserve the last-good output if
it fails.

### Dev reloads can expose partial state

Ordinary runtime edits generally work, but removals reveal stale dependencies retained by the
long-lived Nitro host. Structural changes such as channel routes or instrumentation also require a
worker rebuild. Today the runtime pointer, host inputs, routes, and worker lifecycle are not one
transaction, so a late failure can leave earlier mutations active.

A runtime-only edit should publish a complete generation without replacing the worker. A structural
edit should keep serving the old worker until a replacement has built and reported ready. Failure
at any point should leave the old pointer, routes, worker, and watcher state unchanged.

### A generation is not yet a complete executable unit

A copied runtime snapshot can still depend on authored files or packages outside the snapshot. If
those originals change or disappear, an admitted request or active turn may no longer be able to
load the behavior it selected. Dependency resolution must also follow the same Node ESM rules used
when the code executes.

Each generation therefore needs the complete authored module and dependency closure required to run
that version, including workspace resources, instrumentation, configured externals, and transitive
packages. Framework and deployment runtime packages remain outside the authored generation.

### Worker replacement can interrupt live traffic

The current dev listener proxies to a reloadable Nitro worker. Replacing that worker can reset an
admitted HTTP request, interrupt a stream, or briefly make a dev control or Workflow queue endpoint
unavailable. It also makes cancellation and shutdown ownership unclear.

A stable parent server should own the listener, local Workflow World, queue ingress, and dev control
endpoints. It admits each request or queue delivery to one worker and generation, keeps that
ownership until the operation finishes or disconnects, and does not retire the old worker while
admitted work still depends on it.

### Parked sessions and active turns need different lifetimes

Production resolves `latest` when a Workflow starts and then records the selected deployment on
that run. The local World instead exposes one package-version deployment identity and currently
registers queue handlers from the reloadable worker. It cannot reliably route separate child
Workflows to the generations they selected.

The long-lived session driver should remain generation-neutral. Each child turn Workflow resolves
the latest promoted generation once, and all of that run's workflow, step, retry, and resume
deliveries return to the recorded generation. When the child Workflow becomes terminal, it releases
that reference; the next turn in the same session resolves latest again.

## Goals

- Preserve the fast path that already works: tools, connections, skills, instructions, and similar
  runtime behavior reload without replacing the Nitro worker.
- Make an authored generation complete and immutable so one request or active child Workflow never
  observes a mixture of versions.
- Keep parked sessions on the latest successful authored behavior without changing an active turn
  during replay, retry, or suspension.
- Keep the last working server available while a structural candidate is prepared and discard the
  candidate cleanly if preparation fails.
- Give requests, queue deliveries, workers, and active child Workflows explicit generation
  ownership so shutdown and pruning decisions are safe.
- Keep parent-owned dev and Workflow endpoints available through reloads and prevent planned worker
  replacement from surfacing connection resets.
- Preserve Nitro's selected route identity, including overlapping static and parameter routes.

## Ownership model

```text
authored edit
    │
    ▼
immutable generation ── runtime-only ─────────► publish latest pointer
    │
    └── structural ─► ready Nitro candidate ─► atomically swap pointer, routes, and worker

stable parent server
    ├── owns the listener, local World, queue ingress, and dev control endpoints
    ├── leases one worker and generation per admitted request or queue delivery
    └── retires old workers and generations only after their references are released

generation-neutral session driver
    └── starts child turn with latest ─► generation G for that child Workflow only
```

A generation contains the complete executable authored dependency closure. Nitro host inputs
retained for the server lifetime live outside the prunable generation store. The stable parent does
not reinterpret which authored channel matched a request; it preserves the route Nitro selected and
dispatches that route against the leased generation.

The parent starts exactly one local World. Workers use an eve-owned private World transport rather
than starting competing Worlds or replacing a global direct queue handler. The parent records the
resolved generation on each child Workflow and routes later deliveries by that structured run
record. Public requests cannot select or spoof the generation.

## Delivery

1. **Production build isolation — stop builds from sharing work in progress.** Give each build
   private compiler, host, Nitro, Workflow, and output workspaces, then serialize only final
   publication. This prevents concurrent or failed builds from disturbing each other, the running
   dev server, or the last-good output. This is the current PR.
2. **Immutable generations — make one version of an agent runnable on its own.** Materialize the
   complete authored behavior and dependency closure into a path-independent generation. This keeps
   admitted requests and active turns executable after source files, tools, or packages are changed
   or removed.
3. **Parent worker and World transport — separate stable ownership from reloadable workers.** Put
   readiness, request and generation leases, queue delivery, cancellation, trusted client metadata,
   and bounded shutdown behind a parent-owned listener. This prevents planned worker replacement
   from resetting admitted traffic or leaving the local World bound to a retired worker.
4. **Transactional dev rebuilds — make a reload one complete promotion.** Connect the watcher,
   generation pointer, routes, and candidate worker through one coordinator with complete rollback.
   This preserves fast runtime-only reloads while preventing failed structural changes from leaving
   mixed routes, pointers, handlers, fingerprints, or workers active.
5. **Latest-turn Workflow delivery and pruning — select latest at each child Workflow boundary.**
   Keep the parked session driver generation-neutral, record one generation for each active child
   Workflow, route its retries and resumptions consistently, and prune from structured active-run
   references once the child becomes terminal.

Each stage remains independently valid and does not expose a partially connected lifecycle.

## User-visible result

- Concurrent production builds cannot interfere with each other or a running dev server.
- Adding, editing, or removing an authored tool continues to work without restarting `eve dev`.
- A failed compile, bundle, worker start, route change, or pointer publication keeps the previous
  server fully usable.
- Structural reloads move new traffic only after the replacement worker is ready. Existing requests
  and streams finish on their original worker; disconnect and shutdown cancellation follow an
  explicit owned lifecycle.
- Parent-owned dev and Workflow queue endpoints remain available during reload.
- Channel changes preserve the route Nitro selected, including overlapping routes.
- Advancing and pruning a runtime generation cannot remove Nitro inputs retained by the dev server.
- An active child Workflow completes on its selected generation after a promotion. Once the session
  parks, its next turn uses the newly promoted generation.

## Non-goals

- Replacing Nitro as eve's development or production bundler.
- Restarting the worker for every authored edit.
- Pinning a parked session to the authored generation that originally created it.
- Switching an active child Workflow to newer code during retry, replay, or suspension.
- Keeping every historical generation after no request, worker, candidate, or active child Workflow
  can reference it.

The gray-matter vendoring change is independent of this lifecycle work.
