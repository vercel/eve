---
issue: https://github.com/vercel/eve/pull/6661
status: proposed
last_updated: "2026-11-20"
---

# Hosts and the eve runtime

## Summary

eve runs on Vercel. The goal is that eve can also run on other hosts. Examples are a self-hosted
Node server, a Kubernetes cluster, and a different cloud.

This document gives the internal design for that goal. The design has three parts:

- **The eve runtime.** One value holds the state of the process. Boot fills this value.
- **The host.** The host tells eve about the deployment and about the capabilities that it has.
  eve speaks to the host only through a contract that eve owns.
- **The durable host.** eve uses this interface for durable execution. The Workflow SDK is behind
  it.

The design adds no public API. The behavior on Vercel does not change.

## Problem

Before this work, eve had these problems:

1. **Boot order was implicit.** Generated modules ran in import order. Each module wrote its result
   into a separate process global. Code that ran later read the globals back.
2. **Generic code knew Vercel.** Generic modules read `VERCEL*` environment variables and imported
   Vercel SDKs directly.
3. **One question had three answers.** The question was "what can this host do?". The answers were
   flag methods, fixed tables keyed by the platform name, and decisions inside the consumers.
4. **Other hosts were not able to give implementations.** A host that eve does not ship was not
   able to give its own sandbox, document store, schedules provider, or model credentials.

A test made the gaps clear. The test installed a self-hosted host and checked 11 consumers. Before
the work, 6 checks failed. After the work, all 11 checks pass.

## Design

### The eve runtime

```ts
interface EveRuntime {
  platform: PlatformContext | undefined;
  defaultSession: RuntimeSession | undefined;
  readonly hosts: { routes; sessionEventStores; durable?: DurableHost };
  readonly instrumentation: { runtime?: InstrumentationRuntime; providers };
  onClose(close: () => Promise<void>): void;
  close(): Promise<void>;
}

function eveRuntime(): EveRuntime;
```

The runtime is a container. Boot fills it in stages. `eveRuntime()` returns the runtime of the
process, and it makes the runtime at the first call. Thus a later stage does not remove the state of
an earlier stage.

Boot does these steps in this sequence:

1. `platform/install-runtime` sets `runtime.platform`. It is the first import of the generated
   bootstrap, so it runs before the authored modules load.
2. `bootEveProcess()` sets the queue namespace. Then it installs the compiled artifacts.
3. `bootEve()` writes the Workflow deployment ID and the spec version. Then it creates the World,
   installs the Workflow host, and registers the close of the World with `onClose()`.

Workflow bundles import the bootstrap, but they do not import `bootEve()`. Thus they do not load the
World installation. Nitro calls `runtime.close()` when the server stops.

Each slot of the runtime has one owner module. Only the owner reads and writes the slot. All other
code uses the accessor of the owner. Guard rule 72 enforces this.

| Slot                         | Owner                                               | Accessor                                      |
| ---------------------------- | --------------------------------------------------- | --------------------------------------------- |
| `platform`                   | `platform/context.ts`                               | `platformContext()`                           |
| `hosts` and the durable host | `execution/hosts.ts`                                | `requireDurableHost()`, `registerHost()`, ... |
| `instrumentation`            | `instrumentation/runtime-global.ts`, `providers.ts` | `getInstrumentationRuntime()`, ...            |
| `defaultSession`             | `runtime/sessions/runtime-session.ts`               | `getActiveRuntimeSession()`                   |

The accessors read the runtime directly. eve does not pass the runtime as a parameter, for two
reasons:

- Nitro handlers, Workflow steps, and OpenTelemetry hooks start from outside eve. They cannot
  receive an eve value as an argument.
- Most callers are small helpers in tracing, instrumentation, auth, and the harness. They have no
  context object that can carry the runtime.

### The host contract

A host gives eve a `PlatformContext`. eve owns this type.

```ts
interface PlatformContext {
  readonly build: PlatformBuild; // build target, output directory
  readonly deployment: PlatformDeployment; // facts about the deployment, and its scope
  readonly identity: PlatformIdentity; // workload token and issuer check
  readonly telemetry: PlatformTelemetry;
  readonly workspace: PlatformWorkspace; // transport between agents in one deployment
  readonly capabilities: HostCapabilities;
  readonly hooks?: PlatformHooks;
}
```

The host gives facts as values in code. eve does not read environment variables for a host. The
Vercel platform reads `VERCEL*` variables because Vercel gives its facts in that form. A
self-hosted host can read its facts from any source.

### Host capabilities

A host declares its capabilities one time:

```ts
const capabilities = hostCapabilities("1", {
  documentStore: true,
  modelCredentials: true,
});
```

These rules apply:

- The first argument is the version of the capability API. eve rejects a version that it does not
  know.
- eve rejects combinations that are not valid. `sandboxCredentialTransforms` is valid only together
  with `hostedSandbox`, because the transforms run inside the hosted sandbox.
- `hostCapabilities()` freezes the result and puts a mark on it. `hasCapability()` rejects an object
  without this mark. Thus a host cannot write capabilities by hand, and eve can add capabilities in
  a later version.
- The mark is a `Symbol.for` key. Thus eve accepts capabilities that a different module graph made.

Consumers ask the host. They do not ask for the name of the platform:

```ts
if (hasCapability(platformContext(), "hostedSandbox")) return "vercel";
```

### Hooks

Some capabilities need an implementation. A host gives each implementation as a hook.

| Capability                    | Hook                       | When the host does not declare it                              |
| ----------------------------- | -------------------------- | -------------------------------------------------------------- |
| `hostedSandbox`               | `hostedSandbox(options)`   | eve selects Docker or just-bash. A direct call fails.          |
| `documentStore`               | `documentStore()`          | `fileMemory()` has no default store.                           |
| `scheduleProvider`            | `scheduleProvider()`       | The author must give `provider` to `defineDynamicSchedules()`. |
| `modelCredentials`            | `modelCredentials(token?)` | The author must configure an AI Gateway API key.               |
| `agentRuns`                   | `agentRunsSpanProcessor()` | eve does not export Agent Runs.                                |
| `sandboxCredentialTransforms` | none                       | Deployed self-modification is not available.                   |
| `stopsSandboxesOnExit`        | none                       | eve does not stop sandboxes when the server stops.             |

The build-output port is also a hook, `buildOutput`. It has no capability. Without the hook, eve
uses its built-in port, which can make Vercel output and Node output.

These rules apply to hooks:

- A platform without hooks uses the built-in implementations of eve. The Vercel platform has no
  hooks. Thus the import graph does not change.
- A platform with hooks receives each capability from its hook. It receives the capability only if
  it declares it.
- If a host declares a capability and has no hook for it, eve stops with an error. The error names
  the hook that the host must add.

### Deployment scope and memory

The deployment contract gives a scope:

```ts
interface DeploymentScope {
  readonly platform: string;
  readonly id: string;
  readonly environment: string;
  readonly variant: string | null;
}
```

`scope()` returns `undefined` for a local application. `defaultNamespace()` makes the memory key
from the scope. Thus two deployments with the same container path do not share memory.

The Vercel scope uses the project ID and the environment. For a preview, the variant is the branch,
then the deployment ID, then the URL. The memory keys on Vercel do not change. Tests compare the
full key string.

### Durable execution

"World" is the name that the Workflow SDK uses for its storage, queue, hooks, and streams. eve does
not use this name in its own interfaces. The Workflow binding wraps the World in a `DurableHost`:

```ts
interface DurableHost {
  readonly name: string;
  deliver(to: DeliveryAddress, payload: unknown): Promise<void>;
  deploymentId(): Promise<string>;
  findRun(runId: string): Promise<DurableRun | undefined>;
  runStatus(runId: string): Promise<string>;
  cancelRun(runId: string, reason: string): Promise<void>;
  readonly sessionEvents: SessionEventStore;
  stepAttempt(): number | undefined;
  callbackBaseUrl(): string | undefined;
  createRuntime(config: CreateRuntimeConfig): Runtime;
  readonly connectionEvents: ConnectionEventOwners;
}
```

Generic code uses `requireDurableHost()`. The Workflow engine modules can use the World directly.
These are the binding directories and a list of named modules, for example the session inbox and
the session steps. The named modules stay at their current paths. Workflow makes step IDs from the
module path, so a move breaks the runs that are in progress during a deploy. Guard rule 71 enforces
this boundary.

### Bundles

eve extensions bundle authored code from source. Rolldown follows each import, and it also follows
dynamic imports. Thus an import from a contract module puts its target into the bundle.

These rules keep the Vercel SDKs out of extension bundles:

- The contract modules, `platform/context.ts` and `platform/capabilities.ts`, import no
  implementation.
- The built-in implementations are in separate capability modules. Only the code that uses a
  capability imports its module.
- Only a composition root imports a host module. Examples are the generated bootstrap and the CLI.

### State that stays global

- **The World of the Workflow SDK.** The SDK reads it internally. Only the Workflow engine uses it.
- **Workflow configuration in environment variables.** The queue namespace, the deployment ID, and
  the spec version are SDK inputs. `bootEve()` writes them before it creates the World.
- **The global tracer provider of OpenTelemetry.**
- **Scopes for one call in `AsyncLocalStorage`.** An example is the context container that tools
  read.
- **Brand symbols.** They mark the type of an object. They hold no state.

## Invariants

- One runtime holder exists in each process. Each `eve dev` generation runs in its own worker.
- Only boot and the slot owners read the runtime holder (rule 72).
- Generic code does not read `VERCEL*` variables or import Vercel SDKs (rule 69).
- Code outside `src/platform/` imports only the platform contract and the capability modules
  (rule 70).
- Only the Workflow engine calls `getWorld()` or `setWorld()` (rule 71).
- eve sets the queue namespace before any code makes queue messages (rule 33).
- eve installs the platform before it reads the deployment ID.
- A host declares a capability before eve calls its hook.
- New state for the whole process becomes a runtime slot with one owner. It does not become a new
  `Symbol.for("eve.*")` global.

## Status

These changes are complete. Each change is internal and has a patch changeset.

1. The platform layer and guard rules 69 and 70 (#6661, #6687, #6688).
2. The boot functions and the runtime slots (#6693).
3. The durable boundary and guard rule 71 (#6699).
4. Definitions that resolve defaults at first use, and guard rule 72 (#6700, #6701).
5. The session event store, `createRuntime` as a method, and contract types in eve terms (#6703,
   #6704, #6705).
6. Host capabilities, hooks, and the deployment scope (#6714, #6715, #6716).
7. A test that installs a self-hosted host and checks 11 consumers (#6717).

## Next steps

1. **Host installation.** The generated bootstrap always installs the Vercel platform. The bootstrap
   must import a host module that the application selects. Each process that loads eve code must
   install the host first: the CLI, the framework integrations, the programmatic entries, and the
   test setup.
2. **Host selection.** An application must tell eve which host it uses. This is the first public
   API. Two options are a file in the agent directory and a build option. This decision needs its
   own review.
3. **The write side of the session event store.** Steps write session events to the Workflow stream
   directly. A different durable engine needs a write operation on `SessionEventStore`.
4. **Session operations for a durable engine.** `createRuntime()` returns the full session
   runtime of eve. `connectionEvents` is also specific to Workflow. A different engine needs smaller
   operations: start a session run, continue it, and deliver to it.

## Open questions

- Two different eve versions in one process share the `eve.runtime` holder. A newer version can find
  a runtime without a slot that it expects. A version in the holder key can prevent this. Is this
  necessary?
- The public API uses the word "world" in `experimental.workflow.world` and in about 18 docs pages.
  Which eve name replaces it?
- Nobody measured the cold start before and after this work. Is a measurement necessary before the
  host installation step?
