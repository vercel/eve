---
issue: https://github.com/vercel/eve/issues/5203
status: in-progress
last_updated: "2026-10-22"
---

# Generation-scoped isolation for `eve dev`

## Summary

`eve dev` memory grows on every save until the process is killed. The cause is structural, not
one leaky module: eve keeps long-lived isolates alive and loads each new generation of authored
code into them. Node never unloads an imported ES module, and Rolldown's native memory is
allocated per process, so neither kind of memory comes back while the isolate lives.

This plan gives every generation its own disposable isolates and leaves the dev server process
as a coordinator that never imports authored code and never runs the bundler:

- **Build process per rebuild.** A fresh child process prepares each candidate generation. It
  builds workspace extensions, compiles the agent, stages the generation, and builds the Nitro
  host when the change is structural. Then it exits. A spare process is forked ahead of time, so
  process startup and module loading stay off the save's critical path.
- **Runtime worker per generation.** Activating a new generation also swaps in a fresh Nitro
  worker, using the drain machinery structural rebuilds already use. A pre-started spare worker
  keeps the swap off the critical path.

The plan also fixes the nondeterminism that made unchanged modules produce new bundles on each
save. The relative-extension resolver now attaches each module's `package.json` metadata.

## Problem

Measured on `main` with the built CLI and a synthetic agent of 10 tools sharing a 2.9 MB module.
Heap figures are taken after a forced GC:

| Isolate                     | What it loads per save                                                                                                                 | Observed                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Dev server main thread      | Compile-time `import()` of authored bundles. Rolldown keeps finished generation builds' plugins (and their copies of source) reachable | Heap 61 → 93 MB over 8 runtime saves                          |
| Dev server process (native) | Rolldown builds on the main thread: generation module map, and the Nitro host on structural saves                                      | RSS 1.0 → 2.2 GB over 8 structural saves                      |
| Nitro runtime worker        | `import()` of each activated generation's module map under a new URL. The worker survives every runtime save                           | About +58 MB per save after a session uses the new generation |

#5203 reports the same failure for extension modules: a 4 GB host was OOM-killed on rebuild 4. A
separate report showed an agent with about 600 authored modules growing by 1–6 GB per rebuild.

Recycling isolates inside the same process is not enough. Rolldown builds in worker threads that
are then terminated still raise process RSS from 105 MB to 1.2 GB over 36 builds, and it keeps
growing. The same builds in a child process leave the parent at 106 MB.

A user also reported that the relative-extension resolver returned bare ids. Rolldown therefore
lost `"sideEffects": false` for modules reached by relative path, and which import resolved first
decided whether a module was tree-shaken. Unchanged sources produced different bundles, so
`eve dev` reloaded modules that had not changed.

## Goals and non-goals

Goals:

- Memory in `eve dev` stays bounded by construction, without heap thresholds or heuristics.
- The dev server process never imports authored code and never runs Rolldown.
- Rebuild latency stays close to `main` for runtime saves.
- Identical inputs produce identical bundles.
- Behavior is unchanged for `eve build`, `eve start`, durable runs, and the public API.

Non-goals:

- A module runner or in-process HMR. That needs Vite's transform pipeline, and user code's side
  effects would still live in the host.
- Static extraction of definitions. Tool schemas built with zod and computed definitions need
  evaluation.
- One shared bundle for compile and runtime. Generations inline ordinary dependencies on purpose,
  so a durable run can resume on its generation after the workspace changes.
- Caching the Nitro host across boots, and lazy-loading CLI commands. Both are separate boot-time
  work.

## Architecture

```text
 eve dev (CLI)
   └─ dev server process: coordinator, HTTP proxy, file watcher, Workflow World
        │  never imports authored code, never runs Rolldown
        │
        ├─ build process (one per rebuild, plus one spare)
        │    prepare: workspace extensions → compile → stage generation   ─┐
        │    build host (structural only): create Nitro → build host       │ plain data over IPC
        │    exits when the rebuild finishes                              ◄┘
        │
        └─ Nitro runtime workers (one per generation, plus one spare)
             active ── serves requests for the active generation
             draining ── finishes admitted exchanges, then terminates
             spare ── booted on the current host, waiting for the next generation
```

### One rebuild

1. The watcher reports changes.
2. The coordinator creates an empty host workspace, takes the spare build process, and sends
   `prepare` with the workspace, the changed paths, the previous workspace extensions, and the
   current environment.
3. The build process returns the prepared host as plain data.
4. The coordinator computes the host and runtime fingerprints itself, because it owns the
   authoritative environment.
5. It then acts on the kind of change:
   - **unchanged**: discard the candidate.
   - **runtime**: activate the new generation, then swap to a fresh runtime worker on the same
     host, preferring the ready spare.
   - **structural**: send `build host` to the same build process, swap to a worker running the
     new host, then activate the new generation.
6. The coordinator ends the session, which terminates the build process, and forks the next
   spare. It also asks the dev server to boot a spare runtime worker for the active host.

On structural saves the worker swap comes first and the pointer second, as before. Workers are
generation-neutral, so the new worker serves the previous generation correctly until the pointer
moves, and a failed swap leaves the old worker and the old pointer untouched. On runtime saves
the host is the same, so order does not affect correctness. Activating first keeps the retired
worker from loading the new generation when the spare is ready.

### Boot

- The dev server process forks its first build process before it loads its own server modules,
  so the two startups overlap.
- The same build process prepares the first generation and builds the first host.
- The dev server then starts the first runtime worker and its spare.
- Nitro is no longer created in the dev server process. The listen host therefore comes from
  `--host` or eve's default, and no longer falls back to Nitro's `devServer.hostname`, which only
  an undocumented `nitro.config` could set.

## Invariants

- No isolate imports a generation that it outlives, with one exception: a runtime worker may load
  an older, unpruned generation to resume a durable run on it. That is bounded by snapshot
  retention.
- Build processes carry no state between rebuilds. Everything they need arrives in the request,
  and everything they produce returns as plain data or files in the host workspace.
- Each request replaces the build process's environment with the dev server's, so staged `.env`
  changes apply and nothing from an earlier build leaks in.
- The Docker probe that picks the default sandbox runs at most once per dev server. The dev
  server publishes the first result in an internal environment variable. Later build processes
  receive it with their environment and runtime workers copy it when they start, so the sandbox
  choice stays stable for the session.
- Build processes belong to one dev server. Closing it stops its build processes, including the
  spare, and later rebuilds fail instead of forking new ones.
- The dev server creates each candidate's host workspace and removes it if `prepare` fails, so a
  build process that dies mid-build leaves no workspace behind. A generation snapshot it staged is
  removed later by snapshot retention.
- A host workspace is removed only after the last runtime worker using it has retired. That
  includes active, draining, and spare workers.

## Failure semantics

- A compile error, an evaluation error, or an exhausted heap in the build process fails that
  rebuild. The server keeps serving the previous generation. Errors keep their message, stack,
  and cause chain across the boundary. An abort exit says the build most likely ran out of
  memory and names `--max-old-space-size`.
- A build that waits on work that can never complete makes the build process exit instead of
  hanging. The build process unrefs its IPC channel while a build runs. The rebuild then fails
  with an actionable message.
- On a structural save, a runtime worker that fails readiness leaves the active worker in place,
  and the rebuild fails before activation. On a runtime save the generation is already active,
  so a failed swap is logged and the current worker keeps serving.
- The build process exits when its IPC channel disconnects, so it never outlives the dev server,
  including when the dev server is killed.
- A spare that crashes or goes stale is discarded and replaced. The next swap waits for readiness
  instead.
- Closing the dev server terminates every build process and runtime worker, including spares.

## Performance

Measured with the built CLI against `main`, using the synthetic agent from the problem section:

| Measure                                             | `main`              | This design                                     |
| --------------------------------------------------- | ------------------- | ----------------------------------------------- |
| Dev server RSS, 8 runtime saves each with a session | 1094 → 1298 MB      | 677 → 568 MB, plus a 247 MB spare build process |
| Dev server main-thread heap, same run               | 64 → 98 MB          | 37 → 40 MB                                      |
| Dev server RSS, 8 structural saves                  | 1033 → 2194 MB      | 591 → 639 MB                                    |
| Runtime save, file write to rebuild log line        | 0.59–0.66 s         | 0.70–0.88 s                                     |
| Boot, 1-tool and 10-tool agents                     | ~1.80 s and ~1.92 s | ~1.83 s and ~1.98 s                             |

Runtime saves cost about 0.1 s more. The build process starts with its modules loaded, but its
first compile still runs cold: 180–260 ms against about 80 ms for a warm in-process compile on a
small agent. On large agents, where compile takes seconds, the difference is proportionally
smaller. The runtime worker swap uses the spare and adds nothing measurable.

## Alternatives considered

- **A warm compile worker recycled at a heap threshold** (closed #5191). This bounds JavaScript
  heap but not Rolldown's per-process native memory, and it leaves the runtime worker leak in
  place.
- **Reusing extension module instances across compiles** (#5206). This fixes the #5203 trigger
  but leaves app modules, Rolldown memory, and the runtime worker unchanged.
- **A module runner** (Vite `ModuleRunner`, Nuxt, SvelteKit). This frees inlined modules without
  restarting, but it depends on Vite's transform pipeline, and user code's side effects stay in
  the host.
- **Disposable isolates.** Nitro starts a new worker per `dev:reload`. Vitest recycles workers at
  a memory limit and destroys them on watch reruns. SvelteKit runs build analysis in a fresh
  process. This plan uses that pattern, with a child process where Rolldown runs.

## Testing

- An integration regression covers the resolver: a `"sideEffects": false` workspace module
  reached by relative import is tree-shaken.
- The coordinator's unit tests cover a fresh runtime worker per runtime generation, including
  reuse of the prepared spare. The drained dev server's scenario tests cover workspace disposal
  across recycled, spare, and replaced workers.
- Scenario tests run the packed CLI through boot, rebuilds, shutdown, and the Bun runtime, which
  exercises the build process path end to end.
- Manual measurements on the built CLI cover heap per isolate and process RSS across runtime and
  structural saves, plus rebuild and boot latency against `main`.
