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
  Workflow binding itself; the other 18 calls bypass `DurableHost`, eve's own interface for
  durable execution.
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
  readonly platform: PlatformContext;
  readonly artifacts: () => RuntimeCompiledArtifactsSource;
  readonly durable: DurableHost;
  readonly hosts: HostedRoutes;
  readonly instrumentation: InstrumentationRuntime;
  readonly agents: CompiledAgentCache;
  close(): Promise<void>;
}

async function bootEve(input: EveBootInput): Promise<EveRuntime>;
```

`EveBootInput` carries what the generated code gathers today: the agent name, the platform
implementation, the compiled artifacts input, the durable backend's module and configuration (today
a Workflow World package), and the instrumentation provider modules. The artifacts input is the
compiled data and module map in production, and the dev artifacts configuration in `eve dev`.

`artifacts` resolves the current `RuntimeCompiledArtifactsSource`, the existing `bundled | disk`
union. In production it always returns the bundled source installed at boot. In `eve dev` it
returns a disk source and re-reads the snapshot pointer on each call, as routes do today, so dev
keeps picking up new snapshots. The agent cache stays keyed by source.

`bootEve` performs today's steps in today's order, in one function you can read: platform, queue
namespace, compiled artifacts, the Workflow SDK's deployment ID and spec version, durable host,
instrumentation, and hosted routes. The platform comes first because installing the deployment ID
reads it. Rule 33 only requires the queue namespace before anything that produces queue messages.
`close()` replaces the shutdown hooks that are scattered across plugins today.

### Durable execution stays behind `DurableHost`

"World" is the Workflow SDK's name for its storage, queue, hooks, and streams backend. eve doesn't
adopt it. `bootEve` creates the World, and the Workflow binding wraps it in a `DurableHost`, the
eve-owned interface for delivery, run status, cancellation, the session line store, step attempts,
and the callback URL. `EveRuntime` exposes only `durable`.

Today 18 calls to `getWorld()` in 11 files outside the binding reach past `DurableHost`. Among
them are session-inbox ownership and resume, the session timeout and handoff steps, prewarm, the
legacy-session steps, invocation ownership, and channel dispatch. They move onto `DurableHost`,
which grows only by the operations they actually use. Afterwards only the Workflow binding
(`execution/workflow-host/` and `install-workflow-world.ts`) touches the SDK's World. That
also leaves room for a durable engine other than the Workflow SDK.

### Generated code

The generated boot module only gathers inputs. Data arrives through data imports, as the Nitro host
rules require, and modules arrive through ordinary imports. Production and `eve dev` each have their
own boot module, as they have their own bootstrap today. The module calls `bootEve`
once and installs the result. The runtime plugin and `workflows-handler.mjs` both import this one
module, so it evaluates once. The runtime plugin registers `runtime.close` on Nitro's `close` hook.

### Entry points and the one holder

Nitro calls route handlers, the Workflow runtime calls steps with serialized input, and
OpenTelemetry calls span hooks. None of them can pass an eve value, so one holder remains:
`installEveRuntime(runtime)` and `eveRuntime()`. It is the only way a call from outside reaches the
value boot produced.

Only entry modules read the holder: route handlers, Workflow step and flow entries, Nitro plugin
functions, and CLI commands. Each reads it once and passes the runtime, or the part of it a callee
needs, to everything below.

| Read today                                                | Read after                            |
| --------------------------------------------------------- | ------------------------------------- |
| `platformContext()`                                       | `runtime.platform`                    |
| `getWorld()`                                              | `runtime.durable`                     |
| hosted routes registry                                    | `runtime.hosts`                       |
| runtime-session compiled artifacts and agent bundle cache | `runtime.artifacts`, `runtime.agents` |
| instrumentation runtime and providers                     | `runtime.instrumentation`             |

### Ambient state that stays

- **The Workflow SDK's World global.** The SDK reads its World internally, so `bootEve` calls
  `setWorld` as an adapter. eve's own code uses `runtime.durable`, and only the Workflow binding
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
- Only the Workflow binding calls `getWorld()` or `setWorld()`. A guard rule enforces this.
- Leaf modules import `EveRuntime` as a type only, so the runtime's implementation stays out of
  extension bundles.

## Migration

Each step is an internal refactor with a patch changeset, and existing tests keep passing.

1. Add `EveRuntime` and a `bootEve` facade that runs today's installers in today's order. The
   generated boot module calls it. Behavior is unchanged, and the order becomes explicit.
2. Move each slot into the runtime value, one PR per slot: platform, instrumentation, hosted
   routes, compiled artifacts and the agent cache, then move the remaining `getWorld()` callers
   onto `DurableHost`, so only the Workflow binding touches the SDK's World. Each PR deletes a
   `Symbol.for` slot.
3. Read the runtime once at each entry point and pass it down to route handlers, steps, plugins,
   the harness kernel config, and tracing.
4. Make definitions inert and bind auth strategies when eve resolves them.
5. Add the guard rules for holder access, global state, and World access outside the Workflow
   binding.

## Open questions

- Which paths, if any, evaluate authored definitions and serve requests in the same process
  without going through the generated boot module? Each one needs to call `bootEve` itself.
- Some of today's `getWorld()` callers run inside Workflow steps that the SDK invokes. They reach
  `runtime.durable` through the holder at step entry. The migration needs to confirm that each of
  them has an entry to read from.
- The public surface still uses the SDK's name: the experimental
  `defineAgent({ experimental: { workflow: { world } } })` option, the exported
  `AgentWorkflowWorldDefinition` type, and about 105 lines across 18 docs pages, including concept
  pages that describe eve features in terms of World capabilities. Pick one eve name for the
  concept (for example durable backend, durable engine, or durable host) and rename the
  experimental config and docs together with the durable-engine work. "World" stays only where
  users choose an SDK package such as `@workflow/world-postgres`.
- `bootEve` awaits the durable backend and instrumentation in one place. Cold start should be
  measured against today's boot before step 2 lands.
