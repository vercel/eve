---
issue: TBD
status: in-review
last_updated: "2026-07-13"
---

# Dev revision isolation

## Summary

eve already reloads most authored edits during local development. Changing a tool body,
instructions, or a connection usually works without restarting the server. The remaining problems
appear when an edit removes something, changes server structure, fails partway through, or overlaps
with work that is already running.

One rebuild currently updates several independent pieces of state: compiled artifacts, copied
runtime source, Nitro build inputs, routes, the running worker, and Workflow data. Those pieces do
not share one commit point. A rebuild can therefore publish some new state before another step
fails, leaving the server with a mixture of old and new behavior.

The goal is to treat one compiled version of an agent as a single immutable revision. A revision is
prepared privately and becomes visible only after everything needed to run it is ready. If any step
fails, the last working revision remains fully active.

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

A runtime-only edit should publish a complete revision without replacing the worker. A structural
edit should keep serving the old worker until a replacement has built and reported ready. Failure
at any point should leave the old pointer, routes, worker, and watcher state unchanged.

### A revision is not yet a complete executable unit

A copied runtime snapshot can still depend on authored files or packages outside the snapshot. If
those originals change or disappear, an older request or durable run may no longer be able to load
the behavior it started with. Dependency resolution must also follow the same Node ESM rules used
when the code executes.

Each revision therefore needs the complete authored module and dependency closure required to run
that version, including workspace resources, instrumentation, configured externals, and transitive
packages. Framework and deployment runtime packages remain outside the authored revision.

### Worker replacement can interrupt live traffic

The current dev listener proxies to a reloadable Nitro worker. Replacing that worker can reset an
admitted HTTP request, interrupt a stream, or briefly make a dev control endpoint unavailable. It
also makes cancellation and shutdown ownership unclear.

A stable parent server should own the listener and dev control endpoints. It admits each request to
one worker and one revision, keeps that ownership until the request finishes or disconnects, and
does not retire the old worker while admitted work still depends on it.

### Revision pruning lacks complete ownership information

A revision may still be needed by the active worker, an in-flight request, a candidate worker, or a
durable Workflow run. Age and retention-count heuristics cannot prove that deletion is safe. Nitro
also retains some host inputs for the lifetime of the dev server; those inputs must never live under
a directory that revision pruning can remove.

Pruning should use explicit references. A revision is removable only when it is not active,
candidate, last-good, leased by a request or worker, or referenced by a durable run. Until those
references are available, revisions are retained conservatively.

## Goals

- Preserve the fast path that already works: tools, connections, skills, instructions, and similar
  runtime behavior reload without replacing the Nitro worker.
- Make an authored revision complete and immutable so one request or durable run never observes a
  mixture of versions.
- Keep the last working server available while a structural candidate is prepared and discard the
  candidate cleanly if preparation fails.
- Give requests, streams, workers, and Workflow runs explicit revision ownership so shutdown and
  pruning decisions are safe.
- Keep parent-owned dev endpoints available through reloads and prevent planned worker replacement
  from surfacing connection resets.
- Preserve Nitro's selected route identity, including overlapping static and parameter routes.

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
for the server lifetime live outside the prunable revision store. The stable parent does not
reinterpret which authored channel matched a request; it preserves the route Nitro selected and
dispatches that route against the leased revision.

Durable Workflow runs retain the revision they started with. Pruning removes a revision only when
it is not active, a candidate, last-good, leased by a request or worker, or referenced by a durable
run. Until those references exist, revisions are retained conservatively.

## Delivery

1. **Production build isolation — stop builds from sharing work in progress.** Give each build
   private compiler, host, Nitro, Workflow, and output workspaces, then serialize only final
   publication. This prevents concurrent or failed builds from disturbing each other, the running
   dev server, or the last-good output. This is the current PR.
2. **Immutable revisions — make one version of an agent runnable on its own.** Materialize the
   complete authored behavior and dependency closure into a path-independent revision. This keeps
   older requests and runs executable after source files, tools, or packages are changed or removed.
3. **Parent worker transport — separate the stable server from reloadable workers.** Put readiness,
   request and revision leases, cancellation, trusted client metadata, and bounded shutdown behind
   a parent-owned listener. This prevents planned worker replacement from resetting admitted
   requests, interrupting control endpoints, or leaking workers and revisions.
4. **Transactional dev rebuilds — make a reload one complete promotion.** Connect the watcher,
   revision pointer, routes, and candidate worker through one coordinator with complete rollback.
   This preserves fast runtime-only reloads while preventing failed structural changes from leaving
   mixed routes, pointers, handlers, fingerprints, or workers active.
5. **Durable Workflow and pruning — keep long-running work on the code it started with.** Resolve an
   existing run from its recorded revision and prune only from explicit references. This prevents a
   promoted revision from changing an older run and prevents cleanup from deleting behavior that an
   active run still needs.

Each stage remains independently valid and does not expose a partially connected lifecycle.

## User-visible result

- Concurrent production builds cannot interfere with each other or a running dev server.
- Adding, editing, or removing an authored tool continues to work without restarting `eve dev`.
- A failed compile, bundle, worker start, route change, or pointer publication keeps the previous
  server fully usable.
- Structural reloads move new traffic only after the replacement worker is ready. Existing requests
  and streams finish on their original worker; disconnect and shutdown cancellation follow an
  explicit owned lifecycle.
- Parent-owned dev endpoints remain available during reload and do not depend on the worker being
  replaced.
- Channel changes preserve the route Nitro selected, including overlapping routes.
- Advancing and pruning a runtime revision cannot remove Nitro inputs retained by the dev server.
- Existing Workflow runs continue with their original tools and instructions after newer edits and
  pruning, while new runs use the promoted revision.

## Non-goals

- Replacing Nitro as eve's development or production bundler.
- Restarting the worker for every authored edit.
- Making an in-flight request switch behavior when a newer revision is promoted.
- Keeping every historical revision forever once no owner can reference it.

The gray-matter vendoring change is independent of this lifecycle work.
