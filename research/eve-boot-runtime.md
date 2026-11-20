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

This doc proposes that boot become a function that returns a value. `bootEve()` builds an
`EveRuntime` from the generated inputs in one explicit order. A single holder serves the places eve
is re-entered from outside (Nitro handlers, Workflow steps, plugin hooks). Everything below those
entry points receives the runtime as a parameter, and definitions stay inert until eve resolves
them with it.

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

Only entry modules read the holder: route handlers, Workflow step and flow entries, Nitro plugin
functions, and CLI commands. Each reads it once and passes the runtime, or the part of it a callee
needs, to everything below.

| Read today                                                | Read after                            |
| --------------------------------------------------------- | ------------------------------------- |
| `platformContext()`                                       | `runtime.platform`                    |
| `getWorld()` outside the Workflow engine                  | `requireDurableHost()`                |
| hosted routes registry                                    | `runtime.hosts`                       |
| runtime-session compiled artifacts and agent bundle cache | `runtime.artifacts`, `runtime.agents` |
| instrumentation runtime and providers                     | `runtime.instrumentation`             |

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

Definitions record that they want the platform default, and eve fills it in when it resolves
them:

- Dynamic schedules resolve their default provider at compile time, using the build runtime's
  platform, because the manifest records the provider kind.
- The self-modification sandbox, the `fileMemory` backend and namespace, and the workspace-agent
  transport resolve their defaults when eve resolves the agent graph.
- `DefaultSandbox` already selects its provider inside `prepare(context)`, so the hosted-sandbox
  choice can arrive through the context eve builds for that hook.
- Auth strategies receive the platform issuer check when eve resolves a route's auth chain.

### Build and CLI

Builds get the same shape: `bootBuild({ target })` returns the build-time value (the platform and
the build-output port) that the build root already passes to the Nitro host. CLI commands construct
it at the start of the command.

## Invariants

- One holder per process, and `bootEve` runs once per process. Each `eve dev` generation runs in its
  own worker, with its own globals.
- Only entry modules call `eveRuntime()`. A guard rule enforces this.
- New `globalThis` state under `Symbol.for("eve.*")` outside the holder fails a guard rule. Existing
  slots are baselined, and the baseline can only shrink.
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
3. Read the runtime once at each entry point and pass it down to route handlers, steps, plugins,
   the harness kernel config, and tracing.
4. Make definitions inert and bind auth strategies when eve resolves them.
5. Add the guard rules for holder access, global state, and World access outside the Workflow
   binding.

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
- `bootEve` awaits the durable backend and instrumentation in one place. Cold start should be
  measured against today's boot before step 2 lands.
