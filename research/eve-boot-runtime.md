---
issue: https://github.com/vercel/eve/pull/6661
status: proposed
last_updated: "2026-11-20"
---

# Booting eve into a runtime value

## Summary

eve boots through import-time side effects. Generated modules run in import order and each writes
its result into a process global: the compiled artifacts, the Workflow World, the instrumentation
providers, the durable hosts, and now the platform context. Code that runs later (Nitro route
handlers, Workflow steps, and the definitions in the user's modules) finds that state by reading the
globals back. Nothing ties them together: the order is a convention of who imports whom, and every
dependency is invisible in the signatures that use it.

The platform layer (#6661, #6687, and #6688) made the cost concrete. Moving Vercel access behind a
contract still left 51 `platformContext()` lookups spread through leaf code, because no value flows
from boot to the code that needs it.

This doc proposes that boot fill one `EveRuntime` value in an explicit order, under a single holder.
Each slot of that value (platform, hosts and the durable host, instrumentation, the default runtime
session) has one owner module, and everything else uses the owner's accessor. Definitions stay
inert until eve first uses them.

This is an internal change. It adds no public API and changes no observable behavior.

## How eve boots today

```
Nitro server entry
├─ #eve/runtime plugin
│  ├─ platform/install-runtime  → setPlatformContext()                 [eve.platform-context]
│  ├─ <compiled bootstrap>      → queue namespace env var (rule 33)
│  │                              installBundledCompiledArtifacts()     [runtime-session default]
│  └─ <world plugin>            → WORKFLOW_DEPLOYMENT_ID and spec-version env vars
│                                 await createWorld(); setWorld()      [Workflow SDK global]
├─ instrumentation plugin       → seed, then await register providers  [eve.instrumentation-*]
├─ local-schedules, timezone-schedules, sandbox-shutdown, skill-files, connection-drain
└─ routes (loaded lazily) and workflows-handler.mjs, which imports <world plugin> again;
   ESM's evaluate-once semantics are what keep boot from running twice
```

`eve dev` boots differently. Its bootstrap only sets the queue namespace and never installs bundled
artifacts. Routes resolve a `disk` artifacts source instead, and `resolveNitroCompiledArtifactsSource`
re-reads the dev snapshot pointer each time, so the artifacts root can change inside one worker.
The dev world plugin can also install a client for the parent dev process's World instead of
creating one.

After boot, state is reached through globals:

- 19 source files keep process state on `globalThis` under `Symbol.for("eve.*")`. These include the
  durable hosts, the runtime-session default (compiled artifacts and the agent bundle cache), the
  instrumentation runtime and providers, the platform context, and the sandbox runtimes.
- `getWorld()` has 21 production call sites in 13 files. Only two of those files are the
  Workflow binding itself. Most of the other 18 are the Workflow engine's own session modules;
  only invocation ownership and channel ingress are generic code reaching past `DurableHost`.
- `platformContext()` and the platform capability modules have 51 call sites.

This shape causes four problems:

1. **Order is implicit.** Correctness depends on import order. Guard rule 33 exists to protect one
   such ordering: the queue namespace must be set before anything produces queue messages.
2. **Dependencies are hidden.** A function's signature doesn't say that it needs the World, the
   hosts, or the platform. Tests have to reset globals between runs: `resetTestRealm` deletes
   `eve.hosts` and `eve.instrumentation-runtime`.
3. **Definitions act too early.** `defineDynamicSchedules` picks its default provider, and the
   self-modification sandbox builds its hosted environment, when the user's module is evaluated,
   before eve has resolved anything. Nothing can be passed to them at that point.
4. **Leaf modules reach for implementations.** Globals invite leaf code to import whatever it needs
   directly. eve's own extensions bundle authored code from source, so those imports end up in
   their bundles. That is how an early version of #6661 pulled the Vercel Sandbox SDK into the
   self-modification agent build.

## Proposal

### The runtime value

```ts
interface EveRuntime {
  platform: PlatformContext | undefined;
  defaultSession: RuntimeSession | undefined;
  readonly hosts: { routes; streams; durable?: DurableHost };
  readonly instrumentation: { runtime?: InstrumentationRuntime; providers };
  onClose(close: () => Promise<void>): void;
  close(): Promise<void>;
}

function eveRuntime(): EveRuntime;
async function bootEve(input: EveBootInput): Promise<EveRuntime>;
```

Boot happens in stages across generated modules, so the runtime is a container that boot fills in
rather than a value one call returns. `eveRuntime()` always returns the process runtime and
creates it on first access, so state registered early is never discarded by a later install. The
stages run in today's order: `platform/install-runtime` sets `runtime.platform` as the
bootstrap's first import, before any authored module loads. `bootEveProcess()` sets the queue
namespace and installs the compiled artifacts. `bootEve()` writes the Workflow SDK's deployment ID
and spec version, creates the World, installs the Workflow host, and registers the World's close
with `onClose()`. Workflow bundles import the bootstrap without `bootEve`, so they never load the
World installation.

`defaultSession` holds the compiled artifacts and agent caches outside a scoped session. In
`eve dev` routes still resolve a disk source that re-reads the snapshot pointer on each call, so
dev keeps picking up new snapshots. Rule 33 only requires the queue namespace before anything
that produces queue messages.

### Durable execution stays behind `DurableHost`

"World" is the Workflow SDK's name for its storage, queue, hooks, and streams backend. eve doesn't
adopt it. `bootEve` creates the World, and the Workflow binding wraps it in a `DurableHost`, the
eve-owned interface for delivery, run lookup and status, cancellation, the current deployment ID,
the session line store, step attempts, and the callback URL.

Most of today's `getWorld()` calls are not generic code reaching past `DurableHost`; they are the
Workflow engine itself. Session-inbox ownership and resume, ending stranded sessions, prewarm, the
session timeout and handoff steps, the legacy-session steps, and `workflow-runtime.ts` use hooks,
run lookups, run encryption keys, run ID pinning, and World capability flags. Moving them onto
`DurableHost` would copy the World's interface under another name. Their files can't move into
`execution/workflow-host/` either: Workflow step IDs derive from the module path, so moving a step
module breaks runs in flight across a deploy.

So the boundary is drawn around the engine instead. The binding directories and the named engine
modules may use the World. Generic code reaches durable execution through `requireDurableHost()`,
which grows only by eve-level operations its callers need: `findRun()` for invocation ownership and
`deploymentId()` for channel ingress. Rule 71 enforces the boundary, and a second durable engine
replaces the binding and those engine modules together.

### Generated code

The generated boot modules only gather inputs. Data arrives through data imports, as the Nitro host
rules require, and modules arrive through ordinary imports. The bootstrap imports
`platform/install-runtime` first and calls `bootEveProcess`. The world plugin calls `bootEve` once;
the runtime plugin and `workflows-handler.mjs` both import it, so it evaluates once. The runtime
plugin registers `runtime.close` on Nitro's `close` hook.

### Entry points and the one holder

Nitro calls route handlers, the Workflow runtime calls steps with serialized input, and
OpenTelemetry calls span hooks. None of them can pass an eve value, so one holder remains:
`eveRuntime()`, which returns the process runtime and creates it on first access. It is the only
way a call from outside reaches the value boot built.

### Slot owners

Each slot has one owner module that reads and writes it on the runtime; everything else calls the
owner's accessor. Rule 72 enforces this.

| Slot                         | Owner                                               | Accessor                                      |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------- |
| `platform`                   | `platform/context.ts`                               | `platformContext()`                           |
| `hosts` and the durable host | `execution/hosts.ts`                                | `requireDurableHost()`, `registerHost()`, ... |
| `instrumentation`            | `instrumentation/runtime-global.ts`, `providers.ts` | `getInstrumentationRuntime()`, ...            |
| `defaultSession`             | `runtime/sessions/runtime-session.ts`               | `getActiveRuntimeSession()`                   |

The accessors stay ambient on purpose. Most of their callers are leaf helpers in tracing,
instrumentation, auth, and the harness with no constructed context to receive a parameter from.
Threading the runtime through them would move each lookup up a few frames without adding a
capability. What changed is that every lookup reads one runtime value that boot built, through a
contract eve owns.

### Ambient state that stays

- **The Workflow SDK's World global.** The SDK reads its World internally, so `bootEve` calls
  `setWorld` as an adapter. Generic eve code uses `DurableHost`, and only the Workflow engine
  sees the World.
- **Workflow SDK configuration through env vars.** The queue namespace, deployment ID, and spec
  version are SDK inputs. `bootEve` writes them after installing the platform and before creating
  the World, which preserves rule 33.
- **OpenTelemetry's global tracer provider**, for the same reason as the World.
- **Per-call `AsyncLocalStorage` scopes**, such as the context container that tools and hooks
  read. They are scoped to a call, not boot state.
- **Brand symbols on definitions.** They mark what an object is and hold no state.

### Inert definitions

Definitions don't resolve platform defaults when the user's module loads. `defineDynamicSchedules`
was the one that did; its `provider` is now resolved when eve first reads it, at compile time for
the manifest and at use in the schedules runtime. The others already resolve at use: the default
sandbox selects its provider when eve prepares it, the workspace transport, memory defaults, and
Discord relay read the platform when called, and auth strategies read it per request. The deployed
self-modification sandbox binds its hosted environment at definition because the compiler reads that
environment to compile the sandbox.

### Build and CLI

Builds don't need a runtime value. The build root resolves the build target and build-output port
once and passes them to the Nitro host, the route table, and the plugin list as data.

## Invariants

- One holder per process, and `bootEve` runs once per process. Each `eve dev` generation runs in its
  own worker, with its own globals.
- Only boot and the slot owners reach the runtime. Rule 72 enforces this.
- New process-wide boot state becomes an `EveRuntime` slot with one owner, not a new
  `Symbol.for("eve.*")` global. The remaining `eve.*` symbols are per-feature registries, caches,
  and brands outside this plan.
- Generated code carries data only through `text:` and `bytes:` imports.
- The platform is installed before the deployment ID, which reads it.
- The queue namespace is set before anything that produces queue messages (rule 33).
- Only the Workflow engine (the binding and the named engine modules) calls `getWorld()` or
  `setWorld()`. Rule 71 enforces this.
- Leaf modules import `EveRuntime` as a type only, so the runtime's implementation stays out of
  extension bundles.

## Migration

Each step is an internal refactor with a patch changeset, and existing tests keep passing.

1. Add `EveRuntime`, `bootEveProcess`, and `bootEve`, called by the generated boot modules in
   today's order. The platform install stays the bootstrap's first import.
2. Move each slot onto the runtime, one PR per slot: platform, instrumentation, hosts, and the
   default runtime session. Then route generic durable access through `DurableHost` and add rule 71
   so only the Workflow engine touches the SDK's World.
3. Dropped: passing the runtime down from entry points. "Slot owners" explains why the
   accessors stay.
4. Resolve `defineDynamicSchedules`'s default provider on first use.
5. Add rule 72 so only boot and the slot owners reach the runtime.

## Open questions

- Which paths, if any, evaluate authored definitions and serve requests in the same process
  without going through the generated boot module? Each one needs to call `bootEve` itself.
- The public surface still uses the SDK's name: the experimental
  `defineAgent({ experimental: { workflow: { world } } })` option, the exported
  `AgentWorkflowWorldDefinition` type, and about 105 lines across 18 docs pages, including concept
  pages that describe eve features in terms of World capabilities. Pick one eve name for the
  concept (for example durable backend, durable engine, or durable host) and rename the
  experimental config and docs together with the durable-engine work. "World" stays only where
  users choose an SDK package such as `@workflow/world-postgres`.
- Cold start hasn't been measured against the boot before this plan.
