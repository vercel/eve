---
issue: https://github.com/vercel/eve/pull/6661
status: proposed
last_updated: "2026-11-23"
---

# Platforms for eve

## Summary

eve already runs on platforms other than Vercel. An example is a self-hosted Node server with the
Postgres World. But only Vercel has a formal contract. On other platforms, eve depends on its
defaults and on code that knows Vercel. The goal is a formal contract that each platform can
implement, for example a Kubernetes cluster or a runtime that has no Node process.

This document gives the internal design for that goal:

- **A platform is one file.** `agent/platform.ts` has a `definePlatform()` declaration. The
  declaration gives nine generic entities, for example `Durable`, `Compute`, and `Storage`. Each
  entity answers one question that eve asks. Generic code uses the entities and never asks which
  platform it runs on.
- **An application instance is a value.** The compiler builds `eve:app`, and its `start()` returns
  an app. The code that calls `start()` gives the app to the code that it calls, so no code finds it
  through a global. Two apps in one process share nothing.
- **eve runs a fixed lifecycle.** The order of the phases is a list. The author of a platform
  writes no order.
- **`Durable` hides the engine.** eve ships the Workflow engine, and a platform can write its own.
  Thus a platform can run eve without Workflow.

Three examples show the design in use. The first is a self-hosted Node server with the Postgres
World. The second uses only Cloudflare products, without Workflow. The third uses Temporal as the
durable engine. A platform for another host is in its own package, outside this repository.

The design adds no public API. The behavior on Vercel does not change.

## Problem

Before this work, eve had these problems:

1. **Boot order was implicit.** Generated modules ran in import order. Each module wrote its result
   into a separate process global. Code that ran later read the globals back.
2. **Generic code knew Vercel.** Generic modules read `VERCEL*` environment variables and imported
   Vercel SDKs directly.
3. **Other platforms were not able to give implementations.** A platform that eve does not ship
   was not able to give its own sandbox, document store, schedules provider, or durable engine.
4. **Code found the platform through a global accessor.** Generic code called `platformContext()`
   37 times in 31 files. About half of these calls asked Vercel questions with neutral names, for
   example `build.target() === "vercel"` and `hostedDeploymentId()`.
5. **The platform contract had no shape.** It had 19 methods in five groups, six optional services,
   and the methods of `DurableHost`. Some methods mixed two concerns. For example, `identity` held
   both the check of callers and the credentials for calls that go out.
6. **State was for one process, not for one application.** Two applications, two eve copies, or
   two tests in one process shared one platform and one set of runtime slots.

## Writing a platform

### The platform file

A platform is one file, `agent/platform.ts`. Its default export is a declaration from
`definePlatform()`:

```ts
function definePlatform<C = undefined>(declaration: {
  context?(): C | Promise<C>;
  deployment(app: App, context: C): Deployment;
  durable?(): DurableEngine<C>;
  triggers?(app: App, context: C): Triggers;
  compute?(app: App, context: C): Compute;
  storage?(app: App, context: C): Storage;
  identity?(app: App, context: C): Identity;
  network?(app: App, context: C): Network;
  telemetry?(app: App, context: C): Telemetry;
  build?: Build;
}): PlatformDeclaration;
```

Rules:

- `definePlatform()` returns inert data with a brand. The compiler finds `agent/platform.ts` by its
  path. A default export that is not a `definePlatform()` declaration stops the build with an error
  that tells how to fix it.
- The application has one platform declaration. It cannot merge two declarations.
- Each field is a factory for one entity. The field names are the only names that an author
  writes. Other files of the platform are ordinary modules, for example in `agent/lib/`.
- The fields have no order. A factory that needs another entity reads it from the app, and
  eve makes that entity first.
- `context()` gives the values that exist only at run time, for example the bindings that a
  runtime gives to a request handler. eve calls it one time for each app, and it gives the
  result to each factory and to `DurableEngine.start()`.
- `build` is data, and `durable` takes no context. The build reads only these two fields, and it
  does not call `context()`. Thus the types stop a build from a read of run-time values. `durable`
  returns data and functions, and it opens no resource.
- `agent/platform.ts` loads in two places: the build, which is Node, and the server. Thus it does
  not import, at the top level, a module that only one of them has. It loads such a module in
  `context()`.
- When `agent/platform.ts` does not exist, eve uses its Vercel declaration. It replaces the hidden
  Vercel fallback in `platform/context.ts`, and the behavior on Vercel does not change.

### The entities

Each entity answers one question that eve asks:

| Entity       | Question                                 | When the platform does not give it                                                 |
| ------------ | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `Deployment` | Where and what is this deployment?       | Always given                                                                       |
| `Durable`    | How does work continue after a process?  | The Workflow engine, with the World from `agent.ts` or the local World             |
| `Triggers`   | How does work start at a time?           | Authored schedules run in the server process. Dynamic schedules are not available. |
| `Compute`    | Where does untrusted code run?           | Docker, then `just-bash` in development                                            |
| `Storage`    | Where does state stay outside a session? | The file store on disk                                                             |
| `Identity`   | Who calls in?                            | OIDC route auth is not available                                                   |
| `Network`    | How does eve call out?                   | Plain HTTP to public URLs, with no extra headers                                   |
| `Telemetry`  | Where do traces go?                      | Only the instrumentation of the agent                                              |
| `Build`      | How is the application packaged?         | The Node server of eve                                                             |

```ts
interface Deployment {
  environment(): "development" | "preview" | "production" | undefined;
  deploymentId(): string | undefined;
  publicOrigin(): string | undefined;
  productionOrigin(): string | undefined;
  scope(): DeploymentScope | undefined;
  invocationData?(): Readonly<Record<string, string>>;
}

interface DurableEngine<C = undefined> {
  readonly build?: BuildContribution; // data that the build reads
  start(app: App, context: C): Durable | Promise<Durable>; // opens resources at run time
}

interface Triggers {
  readonly schedules: ScheduleProvider;
}

interface Compute {
  readonly name: string;
  readonly selectByDefault: boolean;
  readonly credentialTransforms: boolean;
  readonly platformStopsSandboxes: boolean;
  environment(options: HostedSandboxOptions): SandboxEnvironment;
}

interface Storage {
  readonly documents?: MemoryDocumentBackend;
}

interface Identity {
  verify(request: Request): Promise<VerifiedCaller | undefined>;
  developmentScope?<T>(request: Request, run: () => Promise<T>): Promise<T>;
}

interface Network {
  self?(url: URL): { readonly headers: Readonly<Record<string, string>> };
  peer?(name: string): { fetch(request: Request): Promise<Response> };
  token?(): Promise<string>;
  fetchUntrusted?(request: Request): Promise<Response>; // replaces the guard of eve
}

interface Telemetry {
  spanProcessors?(environment: string | undefined): readonly SpanProcessor[];
  readonly sessionAttribute?: string;
}

interface Build {
  readonly entry?: string; // a module of the platform that starts the app and serves it
  readonly conditions?: readonly string[]; // the export conditions of the runtime of the entry
  readonly outputDirectory?: string;
  sandboxPrewarmFailure?(error: unknown): Error | undefined;
}
```

Some types are eve code of today: `ScheduleProvider`, `MemoryDocumentBackend`, `SandboxEnvironment`,
`SpanProcessor`, `ConnectionEventOwners`, `ToolStubHost`, `SessionMoves`, and the session `Runtime`.
`HostedSandboxOptions` is the `VercelSandboxCreateOptions` of today. `VerifiedCaller` holds the
claims of the token that `verify()` accepts. Other types are new, and this document defines them.

Rules:

- A feature that only some platforms have is an optional member of its entity. Examples are
  `SessionHost.moves`, `Compute.credentialTransforms`, and `Network.peer`. Generic code does not
  compare platform names.
- `Identity` is only for calls that come in. `Network` is only for calls that go out. Thus
  `Network` has the headers for a callback to this deployment and the transport to a workspace
  agent. It also has the token that eve shows to another service.
- `Triggers` starts work at a time. When a schedule comes due, it delivers to `Durable`. Thus a
  platform can use a schedule product with any engine.
- `Build` is the only entity that eve reads at build time. `DurableEngine.build` adds to it, for
  example the step bundles of the Workflow engine.
- eve validates each entity when it makes it. For example, `Compute.name` cannot be a name that
  `DefaultSandbox` uses for its own providers.
- A value that an author gives comes first. When an author gives no value, for example no
  `provider` in `defineDynamicSchedules()`, eve reads the entity when it uses the definition. A
  `define*` function reads no entity.
- The Vercel concepts are in the Vercel declaration only. For example, the Vercel `Identity`
  verifies `acceptCurrentVercelProject`, and the Vercel `Deployment` adds `vercelDeploymentId` to
  invocation data.

### The entry

`Build.entry` tells eve how the application is served:

- Without `entry`, eve serves the application with its own Node server, as `eve start` does today.
- With `entry`, eve builds `eve:app`. The module in `entry` imports `start` from `eve:app`, starts
  the app, and serves `app.fetch()`. `waitUntil` keeps the work of a channel after the response,
  where the runtime permits it.
- The entry module also imports `eve:instrumentation`, before `eve:app`. In an entry build, this
  module has no top-level `await`. It registers the providers synchronously, and phase 6 of
  `start()` waits for their asynchronous setup. Today the generated module uses top-level `await`
  (`compiled-artifacts.ts`).
- `conditions` gives the export conditions of the runtime to the build. Without the `node`
  condition, the build selects the web version of each module in `src/runtime-env/`. Generic code
  does not read `conditions`.
- A file or an export that a host needs comes from the entry module. eve does not know these files
  and exports.
- The Vercel declaration uses an entry that is internal to eve. It keeps the Vercel output, so the
  limits below do not apply to it.
- A platform for a host other than Vercel is in its own package. The code of eve does not name such
  hosts.

An entry build has no server of its own. `eve start` refuses it. An entry build does not have these
parts of the Node server:

| Part                | Without the Node server                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| WebSocket upgrade   | A channel route with the `WEBSOCKET` method stops the build with an error.        |
| The schedule runner | Authored schedules, also with a time zone, need `Triggers`. Else the build stops. |
| Connection drain    | The host of the entry ends the open requests at shutdown.                         |

An engine can add entry modules through `BuildContribution.entries`, for example a handler that
its product calls. Each one is an output file beside the main entry, and it can import `start`
from `eve:app`. `entries` is valid with or without `Build.entry`. A name that is the same as the
main entry stops the build. When two entries load in one process, they import one module that calls
`start()`.

eve does not ask a platform which runtime it uses. Each part that needs a feature of the runtime
checks for the feature itself, and it stops when the feature is not there:

| Part                            | Check                                                                                                                                                         | When the check fails                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| The local World                 | It finds a disk when the engine starts.                                                                                                                       | The engine does not start. The error tells the author to add `durable`.      |
| The guard for outbound requests | Before its first request, it calls `fetch` with a test dispatcher that stops the call. The result shows if `fetch` uses the guard. No request goes to a host. | eve refuses the request, unless the platform gives `Network.fetchUntrusted`. |

### Out of scope

Model access is a separate change. The model credentials of the current contract stay where they
are until that change.

## How eve runs a platform

### The app

```ts
// eve:app is built by the compiler from the agent directory and agent/platform.ts.
export function start(): Promise<App>;

interface App {
  readonly platform: Entities; // the entities by field name; each is made at its first read
  readonly durable: Durable; // the started engine
  readonly lifetime: Lifetime; // ends when the app stops
  fetch(
    request: Request,
    options?: { waitUntil?(work: Promise<unknown>): void },
  ): Promise<Response>;
}

interface Session {
  readonly id: string;
  readonly lifetime: Lifetime; // the handles of this process; ends at endSession or with the app
}

declare const lifetimeBrand: unique symbol;
interface Lifetime {
  readonly [lifetimeBrand]: true; // only eve makes a lifetime
}

function registerCleanup(lifetime: Lifetime, cleanup: () => void | Promise<void>): void;
function endLifetime(lifetime: Lifetime): Promise<void>;

declare const opaqueBrand: unique symbol;
type Opaque<Tag extends string> = { readonly [opaqueBrand]: Tag }; // JSON data that only eve reads
```

The compiler builds `eve:app` from the platform, the agent directory, and the defaults of eve.
Nothing runs until code calls `start()`. Rules:

- `start()` makes the app of its build and runs the lifecycle. A second call stops with an error
  that tells the caller to keep the first app. The built server is one module graph, so a second
  app from it cannot share nothing. The entry module keeps the promise of its first call.
- Two apps in one process come from two builds, or from tests. A test starts an app from a test
  platform with the internal function under `start()`. Two such apps share nothing.
- The code that calls `start()` keeps the app, and it gives the app to the code that it calls. No
  code finds an app through a global or through `this`.
- An entity is made at its first read, and the app keeps it. A factory that reads another entity
  makes that entity first. A cycle between two factories stops with an error that gives both
  entities.
- A factory runs one time for each app. It receives the app as an argument, and the value that it
  returns keeps the app in its closure.
- A factory is synchronous. Work that must wait goes into `context()` or into
  `DurableEngine.start()`, which eve waits for.
- A value that can change inside one app is a resolver, not a fixed value. The compiled artifacts
  are an example: `eve dev` can change them inside one worker.

Authored callbacks do not change. `execute(input, ctx)` receives a `ToolContext` as before. eve
makes that context for each call from the app of the call.

### Lifetimes and cleanup

An app has a lifetime, and each session has a lifetime. A resource ends with the lifetime that eve
gives to the code that opens it:

- Entity factories receive the app. A resource that an entity opens registers its cleanup on
  `app.lifetime`, so it ends with the application.
- eve makes a `Session` in each process that runs a step of the session. Code that opens a
  resource for one session receives the `Session`. Examples are the connection to a sandbox and an
  MCP connection. The lifetime of a `Session` holds only the handles of its process.
- The steps of a session can run on more than one replica. Thus the durable cleanup is the
  `endSession` step, and it can run on any replica. Today `endSessionSandboxStep` does this part
  for the sandbox (`execution/session/end-sandbox-step.ts`).
- A sandbox has a state that the session keeps in its durable state. The sandbox provider
  contract uses that state in each process. `start()` is an upsert by session ID,
  `resume()` connects again, and `onSessionEnd()` deletes the sandbox (`sandbox/provider.ts`).
  Thus `endSession` and `stopIdleSessionSandbox` stop a sandbox that another replica started.
  `Compute.environment()` returns a provider with this contract.
- `registerCleanup(lifetime, cleanup)` adds a cleanup to a lifetime.
- `endLifetime(app.lifetime)` ends the open session lifetimes first. Then it runs the cleanups of
  the app, in the opposite order of registration.
- Only eve makes a lifetime: one in `start()`, and one for each session. The brand on `Lifetime`
  makes this a type error for other objects.
- Only the code that made a lifetime ends it. Thus eve does not need a separate plugin for sandbox
  shutdown.

A host that discards a process or an isolate without notice does not call `endLifetime()`. Thus
cleanup is not certain, and a platform does not depend on it for correct results.

### The lifecycle

`start()` runs one list of phases. The position in the list is the order:

| Phase                                | Reason for its position                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| 1. Attach `agent/platform.ts`        | Each later phase can read the entities.                     |
| 2. Set the queue namespace           | Rule 33: before any code makes queue messages.              |
| 3. Install the compiled artifacts    | The agent directory and the sessions read them.             |
| 4. Call `context()`                  | Run-time values exist before a factory needs them.          |
| 5. Start the engine as `app.durable` | The Workflow engine reads `Deployment.deploymentId()`.      |
| 6. Install the instrumentation       | It reads `Telemetry`.                                       |
| 7. Load the agent directory          | Each tool, channel, memory, and schedule sees all entities. |

A test checks this order. Thus rule 33 and the order of the platform and the deployment ID are part
of one list, not separate rules.

A build does not start the app. It reads the `build` and `durable` fields of the declaration, and
nothing else.

The Node server of eve starts its own plugins after `start()`: local schedules, skill files, and
connection drain.

`eve dev` runs a shorter list. Its bootstrap installs only the platform and the queue namespace.
The compiled artifacts come from disk, and eve reads the snapshot pointer again at each read. The
engine uses the World that the `eve dev` parent process serves.

### Entry points

An entry point is code that a host calls. It holds an app, or it receives one from the code
that started it:

| Entry point                                 | How it has the app                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| The Node server and the Vercel entry of eve | It calls `start()` from `eve:app` one time and keeps the result. At shutdown, it calls `endLifetime()`. |
| HTTP request                                | The server calls `app.fetch()`. The route handlers receive the app from `fetch()`.                      |
| A platform entry module                     | It imports `start` from `eve:app`. It calls `start()` at the first request, and it keeps the promise.   |
| Engine or trigger code of a platform        | It uses the app of its entry module. It gives the app to `sessionSteps()`, or it reads `app.durable`.   |
| Workflow step                               | The generated step function reads the app of its process.                                               |
| Build                                       | It has no app.                                                                                          |
| OpenTelemetry                               | The app makes the span processors, so they hold the app in their closures.                              |
| Tests                                       | A test starts an app with a test platform, and it calls `endLifetime()` after the test.                 |

The Workflow SDK calls a step function with serialized input only. Thus eve cannot give the app to
a step as an argument. A process that runs Workflow steps has one app, so the generated step
function reads it:

```ts
// A step function. Its name does not change, so its step ID does not change in one version of eve:
export async function runTurnStep(input: TurnStepInput) {
  "use step";
  return turnStep(processApp(), input);
}
```

`processApp()` is internal. Only the generated step functions call it. A scenario test must show
that a step receives the app on the local World, the Postgres World, and Vercel Workflow.

An engine can be process-wide. Examples are the Workflow engine and an engine on a library that
has one instance for each process. Such an engine records its app in `start()`, and it clears the
record in a cleanup on `app.lifetime`. When a second app starts it while the first app lives, it
stops with an error. Thus `DurableEngine` needs no flag for this case.

## Durable

`Durable` is the generic interface for durable work. Generic code uses only this interface. It does
not see a World, a queue, or how an engine keeps sessions:

```ts
interface Durable {
  start(session: SessionStartInput): Promise<void>;
  deliver(to: DeliveryAddress, payload: unknown, options?: { key?: string }): Promise<void>;
  readStream(sessionId: string, from: number): AsyncIterable<StreamLine>;
  tail(sessionId: string): Promise<number>; // the last position, or -1 when the stream is empty
  status(sessionId: string): Promise<SessionStatus | undefined>;
  readonly runs?: WorkflowRuns; // authored workflows
  readonly connectionEvents?: ConnectionEventOwners;
}

type SessionStatus = "running" | "parked" | "paused" | "ended" | "failed";

interface SessionStartInput {
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly addresses: readonly DeliveryAddress[]; // the engine claims these at the start
  readonly body: Opaque<"eve.session-start">; // the engine keeps it and does not read it
}

interface DeliveryAddress {
  readonly key: string; // the engine finds the session from the key, and does not parse it
}

interface StreamLine {
  readonly position: number;
  readonly line: string; // one NDJSON line
}

interface WorkflowRuns {
  start(run: WorkflowRunStartInput): Promise<void>;
  status(runId: string): Promise<SessionStatus | undefined>;
}

interface WorkflowRunStartInput {
  readonly runId: string;
  readonly workflowId: string; // the ID of an authored workflow
  readonly input: Opaque<"eve.workflow-run">;
}
```

- eve makes the session runtime from `Durable`. It is the `Runtime` interface that channels and
  routes use today. Thus each engine serves the same session protocol: NDJSON lines, line
  positions, `startIndex`, leases, and the tail index. Today `DurableHost.createRuntime()` makes
  the `Runtime` inside the engine.
- A step can run more than one time. Thus `start` does nothing when the session exists, and
  `deliver` does nothing when an item with the same key exists.
- A cancel is a delivery to the address of the session. Thus `Durable` has no `cancel`.
- `status` and `tail` take a session ID, because one session can be many runs of an engine.
- `runs` starts the authored workflows of `eve/workflow`. Only the Workflow engine has `runs`. When
  an agent has authored workflows and the engine has no `runs`, the build stops with an error.
- `connectionEvents` keeps the owners of connection event bindings. Only the Workflow engine has it
  today. Without it, eve stops a connection event binding with an error.

The `durable` field of the platform gives an engine. Phase 5 starts the engine as `app.durable`.
The engine can add to the build through `DurableEngine.build`:

```ts
interface BuildContribution {
  readonly routes?: readonly EngineRoute[]; // for example the queue route of Workflow
  readonly entries?: Readonly<Record<string, string>>; // output file name to module; see "The entry"
}

interface EngineRoute {
  readonly path: string;
  readonly handler: string; // a module: export default (request: Request, app: App) => Response
}
```

Each engine decides whether a run stays on the deployment that started it.
`Deployment.deploymentId()` is only a fact about the deployment. An engine can keep runs on their
deployment. Then the platform must keep the workers of each deployment until its runs end, or the
engine must give `SessionHost.moves`. Vercel Workflow keeps runs on their deployment and gives
`moves`. The other engines in this document continue each run on the current deployment.

Each engine runs the session program. The session program does not import Workflow (#6053), and
guard rule 66 keeps it so. The session battery runs the same session tests on each engine (#6352).
It is the conformance suite of `Durable`.

### The Workflow engine

eve ships one engine:

```ts
function workflowEngine(options: { world: (app: App) => World }): DurableEngine;
```

"World" is the name that the Workflow SDK uses for its storage, queue, hooks, and streams. Only the
Workflow engine uses this name. The engine runs each session in a Workflow run, and it adds its step
bundles and its queue route to the build. It makes the World in `start()`, so a build makes no
World. It gives `runs`, `connectionEvents`, `SessionHost.moves`, and `SessionHost.toolStubs`.

The `experimental.workflow.world` option of `agent.ts` stays. When the platform has no `durable`
field, eve uses `workflowEngine()` with the World from that option, or with the local
World. The local World needs a disk.

The Workflow engine modules can use the World directly. These are the binding directories and a
list of named modules, for example the session inbox and the session steps. Guard rule 71
enforces this boundary.

The engine implements `SessionHost` with the tools of Workflow, as the host does today
(`execution/session/workflow-host.ts`):

- `next()` reads the inbox from the hooks of the run. With `until`, it races the inbox with one
  `sleep()`, and it keeps that sleep while `until` stays the same. When the sleep ends first,
  `next()` returns `"due"`.
- `next()` never returns `"park"`. A run that waits on a hook or a sleep uses no compute. A long
  history goes to a new run through `moves`, for example after a compaction.
- `now()` is the clock of the workflow, which a replay gives again. `all()` is
  `Promise.allSettled()`.
- Interrupts go to a turn as today. The run reads each delivery while the turn step runs. It
  aborts a signal for a cancel or for a message that steers the turn. Workflow carries the two
  signals into the step. The step function gives them to the turn as `StepMeta.signals`, so the
  engine does not poll.
- The stream sink is the stream of the run.

The dispatcher of `step()` calls the `"use step"` functions of today. It keeps the order of the
correlation IDs of Workflow, so that a run replays on the same eve code. Rules:

- It calls the step function synchronously, with no `await` before the call.
- It never calls a step function as a method, because Workflow serializes `this`.
- `key` is not an argument of the step function. A step that started before a deploy runs on the
  input that Workflow kept.
- It adds no `sleep()`, hook, or attribute call.

Workflow names each step of eve with the version of eve and the export name of the step. A new
version of eve thus changes the name of each step. The session program can change the order of its
calls only in a new version of eve. Some Worlds do not keep runs on their deployment. On
such a World, the stranded replay guard checks each delivery to a run that another eve started.
Each workflow that eve ships has one of three classes:

| Class       | Workflows                                                       | What the guard does                        |
| ----------- | --------------------------------------------------------------- | ------------------------------------------ |
| Parked      | `workflowEntry` and `turnWorkflow`, but not for a subagent      | No replay. A new message starts a session. |
| Retired     | `workflowToolRunWorkflow`, `connectionEventWorkflow`, subagents | It cancels the run.                        |
| Replay-safe | `sessionTimeoutWorkflow`, `connectionEventDeliveryWorkflow`     | It lets the run replay.                    |

A workflow is replay-safe only when it records no step before its first step after a wait. A
replay on new eve code then runs that step for the first time. Thus the timeout step of a parked
session runs on the new eve, and it ends the session (`timeout-steps.ts`). The classes are a record
with a key for each name in `STABLE_WORKFLOW_NAMES`. Thus a new workflow without a class is a type
error. #6754 adds the classes. Before #6754, the guard checks only `workflowEntry` and
`workflowToolRunWorkflow` (`stranded-replay-guard.ts`).

A build can keep a released version string with different eve code, for example a branch build.
Thus the eve build stamps a hash of its session code, and each run keeps it beside `$eve.version`.
The guard compares both values. An engine that replays its own history compares the hash before
a replay. On a change, it continues the session from its last record in a new run.

### An engine that a platform writes

A platform can write its own engine, for example on a database of the platform or on another
workflow product. The engine implements `DurableEngine`. eve gives it two parts: the session
program, and the work of each step.

The session program comes from `eve/session`. It has no app, uses no Node API, and is
deterministic between steps. It is a generator of commands. `runSession()` runs the generator with
a `SessionHost`. An engine whose own programs are generators uses `sessionProgram()` directly:

```ts
function sessionProgram(run: SessionRun): Generator<SessionCommand, SessionRunResult, unknown>;
function runSession(run: SessionRun, host: SessionHost): Promise<SessionRunResult>;

interface SessionRun {
  readonly start: SessionStartInput;
  readonly record?: SessionRecord; // the last record; none at the first run
}

type SessionRunResult =
  | { readonly kind: "ended"; readonly outcome: "completed" | "failed" | "cancelled" }
  | { readonly kind: "parked"; readonly record: SessionRecord; readonly wakeAt?: number }
  | { readonly kind: "moved" };

interface SessionHost {
  step<N extends SessionStepName>(
    name: N,
    input: SessionStepInput<N>,
    key: string,
  ): Promise<SessionStepResult<N>>;
  next(options?: { until?: number }): Promise<InboxItem | "due" | "park">;
  now(): number;
  all<T extends readonly unknown[]>(
    work: T,
  ): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }>;
  claim(
    addresses: readonly DeliveryAddress[],
    options: { takeOver: boolean },
  ): Promise<ClaimResult>;
  adopted(record: SessionRecord, consumed: { throughSeq: number }): Promise<void>;
  readonly moves?: SessionMoves; // only an engine that moves runs to a new deployment
  readonly toolStubs?: ToolStubHost; // stubbed evals
}

// Each command is one call of SessionHost.
type SessionCommand =
  | {
      readonly kind: "step";
      readonly name: SessionStepName;
      readonly input: unknown;
      readonly key: string;
    }
  | { readonly kind: "next"; readonly until?: number }
  | { readonly kind: "now" }
  | { readonly kind: "all"; readonly commands: readonly SessionCommand[] }
  | {
      readonly kind: "claim";
      readonly addresses: readonly DeliveryAddress[];
      readonly takeOver: boolean;
    }
  | { readonly kind: "adopted"; readonly record: SessionRecord; readonly throughSeq: number };

interface InboxItem {
  readonly id: string; // the same at each retry
  readonly seq: number; // the order that the engine kept, from 1
  readonly body:
    | { readonly kind: "deliver"; readonly to: DeliveryAddress; readonly payload: unknown }
    | { readonly kind: "cancel"; readonly reason: string };
}

type ClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

type SessionRecord = Opaque<"eve.session-record">; // it has a version; the engine does not read it
```

The work of each step comes from `eve/platform`. It uses the app, and it can run on each replica:

```ts
function sessionSteps(
  app: App,
  options: {
    streams: SessionStreamSink;
    interrupts?: SessionInterrupts; // not necessary when the engine gives StepMeta.signals
    content?: SessionContentStore; // without it, content stays in the step result
  },
): SessionSteps;

interface SessionSteps {
  run<N extends SessionStepName>(
    name: N,
    input: SessionStepInput<N>,
    meta: StepMeta,
  ): Promise<SessionStepResult<N> | { readonly yielded: true }>; // yielded: run it again, same key
}

interface StepMeta {
  readonly key: string;
  readonly sessionId: string;
  readonly attempt: number; // 1 at the first attempt
  readonly deadline?: number; // when the invocation ends; a long turn yields before this time
  readonly signals?: { readonly cancel: AbortSignal; readonly steer: AbortSignal };
}

interface SessionInterrupts {
  poll(sessionId: string, afterSeq: number): Promise<readonly InboxItem[]>;
}

interface SessionStreamSink {
  append(sessionId: string, from: number, lines: readonly string[]): Promise<void>;
  close(sessionId: string): Promise<void>;
}

interface SessionContentStore {
  put(sessionId: string, content: Uint8Array): Promise<string>; // the ID is a hash of the content
  get(sessionId: string, id: string): Promise<Uint8Array>;
  delete(sessionId: string): Promise<void>; // endSession calls it
}

// SessionStepTypes maps each step name to { input; result }. It has one entry for each step
// function that the program calls today, for example createSession and turn, and endSession.
type SessionStepName = keyof SessionStepTypes;
type SessionStepInput<N extends SessionStepName> = SessionStepTypes[N]["input"];
type SessionStepResult<N extends SessionStepName> = SessionStepTypes[N]["result"];

const SESSION_LIMITS: { readonly stepResultBytes: 262_144; readonly recordBytes: 262_144 };
```

The two parts can run in different places. The session program can run where there is no app, for
example in the workflow sandbox of Temporal. The steps run where the app is. The Workflow engine
has this split today: the program runs in a `"use workflow"` body, and each step is a `"use step"`
function. Today the program calls about 40 step functions directly, from the loop, the turn, the
finalization, and the moves. Each step that is not part of `moves` becomes a name in
`SessionStepName`, so each engine makes all of them durable in one place.

The record comes from #6455, and #6752 adds it to this stack. It holds the open turn, the run
messages that the session read, and the deliveries that the session gave to its children. The
engine keeps the record, but it does not read it, so the contents can change. A record has a limit
on its size. A list of step results does not.

Rules for the engine:

- The engine runs one `runSession()` at a time for each session.
- The engine makes each `step` durable with its key. A second call with the same key returns the
  kept result.
- `next()` gives the items in the order of `seq`, with no gaps. It returns `"due"` when the time in
  `until` comes. It returns `"park"` when the engine wants to end the run, for example at a limit of
  its history or of its invocation.
- When the program calls `adopted()`, the engine keeps the record and `throughSeq` before the call
  returns.
- To continue a session, the engine calls `runSession()` with the last record. Then `next()` gives
  the items after `throughSeq` again. Examples are after a crash, after `"parked"`, and at a due
  time.
- `now()`, `all()`, and `claim()` are durable. A replay receives the same values.
- `deliver()` also makes the item available to `SessionInterrupts.poll()`. Thus a turn that runs
  can read a cancel, or a message that steers the turn. An engine that pushes the two signals into
  a step that runs gives `StepMeta.signals` instead.
- The stream sink never replaces a line. `append()` writes at `from` only when `from` is the next
  position. Else it throws, and the step runs again. Thus positions only increase, and a reader
  never sees a line change.
- The engine passes the session battery. The battery tests a second `start`, a second `deliver`
  with the same key, and an interrupt in a turn that runs.

Rules for eve:

- The program reads no clock and makes no race outside `SessionHost`. A guard rule enforces this,
  as rule 66 does for Workflow. Today the program uses `Date.now()`, `Promise.race`, and
  `Promise.allSettled`.
- The input and the result of each step are plain data. Today a turn step returns the full history
  and session state (`DurableStepResult` in `turn-step-types.ts`), so a result can be larger than
  `SESSION_LIMITS`. With a `content` store, a step puts each large value in the store, and its
  result has the ID. A retried step puts the same content and receives the same ID. Then each
  result and each record is smaller than `SESSION_LIMITS`. Without a store, the content stays in
  the result, as on Workflow today. The engine gives this store, not `Storage`, because the content
  lives as long as the session. `endSession` deletes it.
- A turn step stops or steers the turn from `StepMeta.signals`, or else from `interrupts`. It
  applies the rules of `active-turn.ts` to each item: a cancel of this turn, or a message that
  steers it.
- A retried step reads the lines of the earlier attempt from its start position. It appends lines
  that close the open records of that attempt as interrupted, as `readOrphanedLines()` and
  `supersede()` do today. `StepMeta.attempt` tells the step that it is a retry.
- A turn step yields before `deadline`. The program runs it again with the same key.
- `runSession()` reads the records of the previous minor version of eve. It stops a newer record
  with a `SessionRecordTooNew` error.
- The module `eve/session` imports no Node API, does no I/O, and reads no global. #6753 removes
  most Node APIs from the session core. Today the program still reaches Node through the platform
  layer and the guarded fetch. Step 4 removes both from the program: only step code uses them, and
  step code runs with the app. Guard rule 65 follows the value imports of the browser entries, and
  it stops at a Node builtin. Step 4 adds the `eve/session` entry to that rule.
- The program imports no `"use step"` function. Each step goes through `SessionHost.step()`. A
  guard rule enforces this for the modules of rule 66.

### Engines that keep sessions in a store

Many products give durable steps and a wake, but no ordered inbox, no stream, and no address map.
For these engines, eve has a store interface. The platform gives a store, and the engine gives only
a wake:

```ts
interface SessionStore {
  begin(start: SessionStartInput): Promise<void>; // does nothing when the session exists
  claim(
    sessionId: string,
    addresses: readonly DeliveryAddress[],
    takeOver: boolean,
  ): Promise<ClaimResult>;
  sessionFor(address: DeliveryAddress): Promise<string | undefined>;
  enqueue(sessionId: string, item: Omit<InboxItem, "seq">): Promise<number>; // same ID, same seq
  itemsAfter(sessionId: string, seq: number, limit: number): Promise<readonly InboxItem[]>;
  saveRecord(sessionId: string, record: SessionRecord, throughSeq: number): Promise<void>;
  loadRun(
    sessionId: string,
  ): Promise<{ start: SessionStartInput; record?: SessionRecord; throughSeq: number } | undefined>;
  status(sessionId: string): Promise<SessionStatus | undefined>;
  setStatus(sessionId: string, status: SessionStatus): Promise<void>;
  readonly streams: SessionStreamSink & {
    read(sessionId: string, from: number): AsyncIterable<StreamLine>;
    tail(sessionId: string): Promise<number>;
  };
  readonly content: SessionContentStore;
}

function storeDurable(options: { store: SessionStore; wake(sessionId: string): Promise<void> }): {
  durable: Durable;
  interrupts: SessionInterrupts;
  streams: SessionStreamSink;
  content: SessionContentStore;
};
```

`storeDurable()` makes `Durable`, the interrupts, the stream sink, and the content store from the
store. `deliver()`
adds the item to the store, and then it calls `wake()`. The engine starts or wakes the run of the
session. A store for one database is in its own package. Thus eve adds no runtime dependency.

This table shows how each engine that this design examined fits the interface:

| Engine                     | The program runs in                  | Inbox and wake                        | Park and continue                    |
| -------------------------- | ------------------------------------ | ------------------------------------- | ------------------------------------ |
| Workflow                   | A `"use workflow"` body              | Hooks                                 | `sleep()`, and `moves`               |
| Temporal                   | The workflow sandbox                 | A store, and a signal as the wake     | `continueAsNew()`                    |
| Durable Task, Dapr         | A generator, from `sessionProgram()` | External events                       | `continueAsNew()`                    |
| Restate                    | A virtual object handler             | A store, and an awakeable as the wake | A new invocation at the next wake    |
| Resonate                   | An async function                    | A store                               | A detached call                      |
| Inngest                    | A function, run again from the top   | A store, and an event as the wake     | A new run at each wake               |
| Trigger.dev                | A task process                       | A store, or session input             | A new run on the latest version      |
| DBOS, Hatchet              | A workflow or a durable task         | A store                               | A short run at each wake             |
| Lambda durable functions   | A durable handler                    | A store, and a callback               | A new execution for each generation  |
| Step Functions             | A task that the state machine starts | A task token                          | An execution at each wake            |
| Cloudflare Workflows       | A workflow instance                  | A Durable Object, and `sendEvent()`   | A new instance before the step limit |
| Cloudflare Durable Objects | An alarm                             | SQLite                                | An alarm                             |

## Other parts of the design

### Deployment scope and memory

```ts
interface DeploymentScope {
  readonly platform: string;
  readonly id: string;
  readonly environment: string;
  readonly variant: string | null;
}
```

`scope()` returns `undefined` for a local application. The memory file store makes the memory key
from the scope. Thus two deployments with the same container path do not share memory. The
memory keys on Vercel do not change. Tests compare the full key string.

### Bundles

eve extensions bundle authored code from source. Rolldown follows each import, and it also follows
dynamic imports. These rules keep the platform SDKs out of extension bundles:

- The app and the entity interfaces import no implementation.
- Each built-in value is in a separate module. Only its factory imports it.
- Only an entry point imports `agent/platform.ts`.

### State that stays global

- **The app of a process-wide engine.** The Workflow engine records it, because the Workflow SDK
  gives a step only serialized input. The generated step functions read it.
- **The World of the Workflow SDK.** The SDK reads it internally. Only the Workflow engine uses it.
- **Workflow configuration in environment variables.** The queue namespace, the deployment ID, and
  the spec version are SDK inputs. The Workflow engine writes them before it makes the World.
- **The global tracer provider of OpenTelemetry.**
- **Brand symbols.** They mark the type of an object. They hold no state.

## Example: a self-hosted Node server with the Postgres World

An operator runs the agent as a container image on Kubernetes, with three replicas and one
PostgreSQL database. The agent uses the Workflow engine on the Postgres World, and PostgreSQL for
memory documents. The model is a model object, so model calls go directly to the provider.

`agent/platform.ts` is the proposal of this design for platform selection (next step 6). That
decision needs its own review.

### The files

```text
agent/
  agent.ts
  platform.ts
  lib/postgres-documents.ts
  tools/lookup-order.ts
Dockerfile
```

```ts title="agent/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-opus-5.5"),
});
```

```ts title="agent/platform.ts"
import { definePlatform, registerCleanup, workflowEngine } from "eve/platform";
import { createWorld } from "@workflow/world-postgres";
import pg from "pg";

import { postgresDocuments } from "./lib/postgres-documents";

const origin = "https://support-agent.acme.internal";

export default definePlatform({
  deployment: () => ({
    environment: () => "production",
    deploymentId: () => process.env.IMAGE_TAG,
    publicOrigin: () => origin,
    productionOrigin: () => origin,
    scope: () => ({
      platform: "acme-kubernetes",
      id: "support-agent",
      environment: "production",
      variant: null,
    }),
  }),

  durable: () =>
    workflowEngine({
      world: () =>
        createWorld({ connectionString: process.env.DATABASE_URL!, jobPrefix: "support_agent_" }),
    }),

  storage: (app) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 10 });
    registerCleanup(app.lifetime, () => pool.end());
    return { documents: postgresDocuments(pool) };
  },
});
```

```ts title="agent/lib/postgres-documents.ts"
import { MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory";
import type pg from "pg";

export function postgresDocuments(pool: pg.Pool): MemoryDocumentBackend {
  return {
    async read({ key }) {
      const { rows } = await pool.query(
        "select content, version::text from memory_documents where key = $1",
        [key],
      );
      return rows[0] ?? null;
    },
    async write({ key, content, expectedVersion }) {
      const { rows } =
        expectedVersion === null
          ? await pool.query(
              `insert into memory_documents (key, content, version) values ($1, $2, 1)
               on conflict (key) do nothing returning content, version::text`,
              [key, content],
            )
          : await pool.query(
              `update memory_documents set content = $2, version = version + 1
               where key = $1 and version = $3::bigint returning content, version::text`,
              [key, content, expectedVersion],
            );
      if (rows.length === 0) throw new MemoryDocumentConflictError(key);
      return rows[0];
    },
  };
}
```

The platform reads two environment variables of the application in its factories. eve reads none
of them. The platform module decides where its settings come from.

The World has no `deploymentId`, so it does not keep runs on a deployment. After a rollout, the new
replicas continue the runs that the old replicas started. With a `deploymentId`, the operator must
keep the old replicas until their runs end.

### Boot and calls

1. `eve build` reads the declaration. The platform has no `build` field, so the output is a Node
   server. The Workflow engine adds its step bundles. The build calls no runtime factory, so it does
   not connect to PostgreSQL.
2. A Kubernetes job runs `bootstrap` from `@workflow/world-postgres` before each rollout. This
   command makes the World schema.
3. `eve start` starts in each replica. The Node server of eve calls `start()`. Phase 5 starts
   the engine as `app.durable`.
4. The Workflow engine records the app for the process, and it registers the direct queue
   handler. Graphile
   Worker gives each job to one replica, and the step runs in that replica.
5. An HTTP request reaches `app.fetch()`. A memory write uses
   the `storage` entity, which uses the pool that its factory opened.
6. At shutdown, the server calls `endLifetime(app.lifetime)`. It closes the pool and the World in
   the opposite order of registration.

### What the operator has

| Entity     | Result                                                                               |
| ---------- | ------------------------------------------------------------------------------------ |
| `Durable`  | The Workflow engine on the Postgres World. Each replica processes jobs.              |
| `Storage`  | PostgreSQL, with optimistic writes.                                                  |
| `Compute`  | Not set, so `DefaultSandbox` uses Docker when it exists.                             |
| `Triggers` | Not set. Authored schedules run in each server. Dynamic schedules are not available. |
| `Identity` | Not set. OIDC route auth is not available, and channels use their own auth.          |
| `Network`  | Not set. Callbacks and workspace agents use plain HTTP.                              |

## Example: an application that uses only Cloudflare products

An operator runs the agent on Cloudflare Workers, without Workflow. Each entity uses a Cloudflare
product:

| Entity       | Cloudflare product                                                                       |
| ------------ | ---------------------------------------------------------------------------------------- |
| `Deployment` | The version metadata binding                                                             |
| `Durable`    | An engine that the platform writes, with a Durable Object per session                    |
| `Triggers`   | One Durable Object for each schedule, with an alarm                                      |
| `Compute`    | Containers, from a Durable Object class (Sandbox SDK 1.0)                                |
| `Storage`    | R2, with conditional writes on the ETag                                                  |
| `Identity`   | Cloudflare Access tokens                                                                 |
| `Network`    | Service bindings to other Workers, and the global `fetch` for URLs from users and models |
| `Build`      | An entry module: the Worker `fetch` handler and the Durable Object classes               |

### How Durable Objects run sessions

A Durable Object has one live instance for each ID, runs one call at a time, and has its own
SQLite storage and one alarm. Thus each rule for an engine has a direct equivalent:

| Rule for an engine                           | Durable Object                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| One run at a time for each session           | One instance for each session ID. Calls run one at a time.                |
| Make each step durable with its key          | Write the result of the step to SQLite, with its key, before it returns.  |
| Give the items in order                      | A SQLite table with `seq` as the primary key                              |
| `"park"` when there is no work               | `next()` returns `"park"` when the inbox is empty.                        |
| Keep the record and `throughSeq`             | Write them to SQLite before `adopted()` returns.                          |
| Continue from the last record                | Read the record from SQLite. `next()` gives the items after `throughSeq`. |
| Interrupts                                   | `poll()` reads the inbox table while a turn runs.                         |
| The stream sink writes only the next line    | The line position is the primary key, so a second write fails.            |
| Large content leaves the step result         | A SQLite table, with the hash of the content as the key                   |
| A delivery or a due time starts the next run | `ctx.storage.setAlarm()`                                                  |

### The files

```text
agent/
  agent.ts
  platform.ts
  lib/engine.ts           # Durable: RPC to the EveSession objects
  lib/session-store.ts    # The inbox, record, steps, streams, and SessionHost of one session, on SQLite
  lib/access.ts           # Identity: verifies Cloudflare Access tokens
  lib/alarm-schedules.ts  # Triggers: a ScheduleProvider on the EveSchedule objects
  lib/r2-documents.ts     # Storage
  lib/sandbox-client.ts   # Compute
  lib/worker.ts           # The entry: the Worker fetch handler and the Durable Object classes
Dockerfile                     # The sandbox image
wrangler.jsonc
```

```jsonc title="wrangler.jsonc"
{
  "name": "support-agent",
  "main": ".output/server/index.mjs",
  "compatibility_date": "2026-11-20",
  "compatibility_flags": ["nodejs_compat"],
  "version_metadata": { "binding": "CF_VERSION_METADATA" },
  "r2_buckets": [{ "binding": "EVE_MEMORY", "bucket_name": "support-agent-memory" }],
  "services": [{ "binding": "BILLING_AGENT", "service": "billing-agent" }],
  "containers": [
    {
      "class_name": "EveSandbox",
      "scheduling_policy": "durable_object",
      "images": { "sandbox": { "dockerfile": "./Dockerfile" } },
    },
  ],
  "durable_objects": {
    "bindings": [
      { "name": "EVE_SESSIONS", "class_name": "EveSession" },
      { "name": "EVE_ADDRESSES", "class_name": "EveAddress" },
      { "name": "EVE_SCHEDULES", "class_name": "EveSchedule" },
      { "name": "EVE_SANDBOX", "class_name": "EveSandbox" },
    ],
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["EveSession", "EveAddress", "EveSchedule", "EveSandbox"],
    },
  ],
}
```

```ts title="agent/platform.ts"
import { definePlatform } from "eve/platform";

import { verifyAccessToken } from "./lib/access";
import { alarmSchedules } from "./lib/alarm-schedules";
import { durableObjectEngine } from "./lib/engine";
import { r2Documents } from "./lib/r2-documents";
import { cloudflareSandbox } from "./lib/sandbox-client";

const origin = "https://support-agent.acme.workers.dev";

export default definePlatform({
  context: async () => (await import("cloudflare:workers")).env as Env,

  deployment: (app, env) => ({
    environment: () => "production",
    deploymentId: () => env.CF_VERSION_METADATA.id,
    publicOrigin: () => origin,
    productionOrigin: () => origin,
    scope: () => ({
      platform: "cloudflare",
      id: "support-agent",
      environment: "production",
      variant: null,
    }),
  }),

  durable: () => durableObjectEngine(),
  triggers: (app, env) => ({ schedules: alarmSchedules(env.EVE_SCHEDULES) }),
  compute: (app, env) => cloudflareSandbox(env.EVE_SANDBOX),
  storage: (app, env) => ({ documents: r2Documents(env.EVE_MEMORY) }),
  identity: () => ({ verify: (request) => verifyAccessToken(request, "acme") }),
  network: (app, env) => ({
    peer: (name) => env[name],
    fetchUntrusted: (request) => fetch(request),
  }),
  build: { entry: "./lib/worker.ts", conditions: ["workerd", "worker", "browser"] },
});
```

`agent/platform.ts` imports no Cloudflare module at the top level. The build entry point is Node,
and Node does not have `cloudflare:workers`. `context()` loads the bindings at run time, and each
factory receives them as `env`. Only `worker.ts` imports `cloudflare:workers` at the top level, and
only the Worker loads `worker.ts`.

The guard of eve needs a `fetch` that uses its dispatcher. The global `fetch` of a Worker does not
use it, so the guard refuses each request. Thus the platform gives `fetchUntrusted`. The global
`fetch` of a Worker cannot connect to private addresses, so it is a guard for this platform.

```ts title="agent/lib/engine.ts"
import type { DurableEngine } from "eve/platform";

import { addressKey } from "./session-store";

export function durableObjectEngine(): DurableEngine<Env> {
  return {
    start(app, env) {
      const { EVE_SESSIONS: sessions, EVE_ADDRESSES: addresses } = env;
      const session = (sessionId: string) => sessions.getByName(sessionId);
      return {
        start: (input) => session(input.sessionId).start(input),
        async deliver(to, payload, options) {
          const sessionId = await addresses.getByName(addressKey(to)).find();
          if (sessionId === undefined) throw new Error(`No session holds "${addressKey(to)}".`);
          await session(sessionId).deliver(to, payload, options?.key);
        },
        readStream: (sessionId, from) => session(sessionId).readStream(from),
        tail: (sessionId) => session(sessionId).tail(),
        status: (sessionId) => session(sessionId).status(),
      };
    },
  };
}
```

The engine reads the bindings in `start()`. Thus the build reads `durable` in Node without the
bindings. The engine has no `runs` and no `moves`. A cancel comes through `deliver()`.

```ts title="agent/lib/worker.ts"
import "eve:instrumentation";
import { start } from "eve:app";
import { DurableObject } from "cloudflare:workers";
import {
  sessionSteps,
  type App,
  type DeliveryAddress,
  type ScheduleRecord,
  type SessionStartInput,
} from "eve/platform";
import { runSession } from "eve/session";

import { nextOccurrence } from "./alarm-schedules";
import { sqliteSession } from "./session-store";

let started: Promise<App> | undefined;
const app = () => (started ??= start());

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) =>
    (await app()).fetch(request, { waitUntil: (work) => ctx.waitUntil(work) }),
};

export class EveSession extends DurableObject<Env> {
  private session() {
    return sqliteSession(this.ctx.storage.sql, this.env.EVE_ADDRESSES);
  }

  async start(input: SessionStartInput): Promise<void> {
    await this.session().begin(input);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async deliver(to: DeliveryAddress, payload: unknown, key?: string): Promise<void> {
    this.session().enqueue(to, payload, key);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async readStream(from: number) {
    return this.session().streams.read(from);
  }

  async tail(): Promise<number> {
    return this.session().streams.tail();
  }

  async status() {
    return this.session().status();
  }

  async alarm(): Promise<void> {
    const session = this.session();
    const { streams, interrupts, content } = session;
    const steps = sessionSteps(await app(), { streams, interrupts, content });
    const result = await runSession(session.run(), session.host(steps));
    session.finish(result);
    if (result.kind === "parked" && result.wakeAt !== undefined) {
      await this.ctx.storage.setAlarm(result.wakeAt);
    }
  }
}

export class EveAddress extends DurableObject<Env> {
  async claim(sessionId: string): Promise<string> {
    const current = await this.ctx.storage.get<string>("session");
    if (current !== undefined) return current;
    await this.ctx.storage.put("session", sessionId);
    return sessionId;
  }

  async find(): Promise<string | undefined> {
    return this.ctx.storage.get<string>("session");
  }
}

export class EveSchedule extends DurableObject<Env> {
  async put(record: ScheduleRecord): Promise<void> {
    await this.ctx.storage.put("record", record);
    await this.ctx.storage.setAlarm(nextOccurrence(record.expression, Date.now()));
  }

  async alarm(): Promise<void> {
    const record = await this.ctx.storage.get<ScheduleRecord>("record");
    if (record === undefined) return;
    await (await app()).durable.deliver(record.target, record.payload);
    await this.ctx.storage.setAlarm(nextOccurrence(record.expression, Date.now()));
  }
}

export class EveSandbox extends DurableObject<Env> {
  async run(argv: string[], cwd: string, variables: Record<string, string>) {
    if (!this.ctx.container.running) this.ctx.container.start();
    const process = await this.ctx.container.exec(argv, { cwd, env: variables });
    const result = await process.output();
    return {
      exitCode: result.exitCode,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }
  // readFile, writeFile, and spawn use the Files class of @cloudflare/sandbox in the same way.
}
```

`sqliteSession()` in `session-store.ts` keeps one session in the SQLite storage of its Durable
Object. `run()` gives the start input and the last record. `host(steps)` gives the
`SessionHost`. Its `step()` keeps each result in SQLite with its key, so an alarm that runs again
does not do a step two times. Its `next()` reads the inbox in the order of `seq`. When the inbox
is empty, `next()` returns `"park"`, or `"due"` when the time in `until` is past. Thus a run ends
when the session has no work, and a delivery or the alarm starts the next run. `next()` also
returns `"park"` near the time limit of an alarm. `adopted()` writes the record and `throughSeq`.
`streams` writes stream lines with the position as the primary key. `interrupts` reads the inbox
while a turn runs. `content` keeps large content in SQLite. `finish()` keeps the status. `begin()`
claims the addresses of the session in `EveAddress` objects, and `addressKey()` makes the key of an
address.

`alarmSchedules()` is a `ScheduleProvider`. It keeps each schedule in the `EveSchedule` object of
its name, with the target from `ScheduleProviderContext`. `r2Documents()` and
`cloudflareSandbox()` follow the same pattern on R2 and on `EveSandbox`.

This table shows where each part fits into the design:

| Code                                       | Part of the design                                                             | Caller                               |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| The default export of `worker.ts`          | The entry (`Build.entry`): it starts the app and serves `app.fetch()`          | Cloudflare, for each request         |
| `durableObjectEngine()` in `platform.ts`   | The `durable` field: a `DurableEngine` that the platform writes                | Phase 5 of the lifecycle             |
| `EveSession` RPC methods and `EveAddress`  | The storage behind `Durable`                                                   | `durableObjectEngine()`, through RPC |
| `sqliteSession().run()` and `host(steps)`  | The start input, the record, and the `SessionHost` of one session              | `runSession()`                       |
| `EveSession.alarm()`                       | Engine code: `sessionSteps()` with the app of `worker.ts`, then `runSession()` | Cloudflare, when the alarm comes due |
| `alarmSchedules()` and `EveSchedule.put()` | The `triggers` field: the `Triggers` entity                                    | The schedules client                 |
| `EveSchedule.alarm()`                      | Trigger code: `app.durable.deliver()`                                          | Cloudflare, when the alarm comes due |
| `cloudflareSandbox()` and `EveSandbox`     | The `compute` field: the `Compute` entity                                      | The code that opens a sandbox        |
| `r2Documents()`                            | The `storage` field: the `Storage` entity                                      | The memory file store                |
| `verifyAccessToken()`                      | The `identity` field: the `Identity` entity                                    | OIDC route auth                      |
| The service binding lookup                 | The `network` field: `Network.peer`                                            | Calls to workspace agents            |
| The global `fetch`                         | The `network` field: `Network.fetchUntrusted`                                  | `web_fetch` and session callbacks    |

### Boot and calls

1. `eve build` reads the declaration. It builds the app, and it bundles `worker.ts` around it.
2. `wrangler deploy` uploads the Worker, the Durable Object classes, and the sandbox image.
3. A user sends a message. The `fetch` handler of `worker.ts` starts the app at the first request
   of the isolate, and it gives each request to `app.fetch()`. The route calls the session
   runtime, which calls `Durable.deliver()`. The engine finds the session through
   its address, and it calls `EveSession.deliver()` through RPC.
4. `EveSession.deliver()` keeps the delivery in SQLite and sets the alarm. `EveSession.alarm()`
   makes the steps with `sessionSteps()` and the app, and it calls `runSession()`.
5. The session program runs. Each step keeps its result in SQLite, and `adopted()` keeps the
   record. When the inbox is empty, `next()` returns `"park"`. The program returns `"parked"`,
   and `alarm()` sets the next wake time.
6. A client reads the stream route. The session runtime calls `Durable.readStream()`. The NDJSON
   lines, positions, and leases are the same as on Vercel.
7. A dynamic schedule comes due. `EveSchedule.alarm()` delivers the occurrence through
   `app.durable.deliver()`.

An alarm that throws runs again later. The next run continues from the last record.

### What is not ready

| Part                                            | Status                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Durable`, `runSession()`, and `sessionSteps()` | Not built (next step 4). Today `DurableHost.createRuntime()` makes the `Runtime` inside the engine.                                                                                        |
| `Build.entry`                                   | Not built (next step 5). The build must make the handler module that `worker.ts` imports.                                                                                                  |
| The Workflow engine                             | This example writes its own engine. If the Workflow runtime can run without Node, the platform can give only a World. This is an open question.                                            |
| The engine of this example                      | Not written. The session battery must pass on it. The battery runs in Node today, and it must also run in the Workers runtime.                                                             |
| Authored workflows                              | This engine has no `runs`. An agent with authored workflows does not build for this platform.                                                                                              |
| Authored schedules                              | `EveSchedule` serves dynamic schedules. Authored schedules need the same objects, made at deploy.                                                                                          |
| Long runs                                       | An alarm handler has a time limit. `next()` returns `"park"` near the limit, and the next alarm continues from the record. A turn yields before its deadline.                              |
| Node APIs                                       | Workers have `nodejs_compat`, but no processes and no local Docker. The Docker and `just-bash` sandboxes and the file store on disk do not work. The platform sets other entities instead. |
| Credential transforms                           | Containers can intercept outbound requests. `Compute.credentialTransforms` is `false` until an adapter uses that feature.                                                                  |
| Instrumentation                                 | Not built (next step 5). A Worker cannot wait for I/O while its modules load, so `eve:instrumentation` has no top-level `await` in an entry build.                                         |
| Model access                                    | Out of scope for this design.                                                                                                                                                              |

## Example: Temporal as the durable engine

An operator runs the agent as a container image on Kubernetes, as in the Postgres example. A
Temporal cluster is the durable engine, without Workflow. The platform writes the engine. The other
entities are the same as in the Postgres example.

### How Temporal runs sessions

The session program runs in a Temporal workflow, and each step runs as a Temporal activity. A
`SessionStore` on PostgreSQL keeps the inbox, the stream, and the addresses. A signal wakes the
workflow. Each rule for an engine has an equivalent:

| Rule for an engine                          | Temporal                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| One run at a time for each session          | One workflow execution for each session. The workflow ID is the session ID.                       |
| Make each step durable with its key         | Each step is an activity. Temporal keeps its result in the history.                               |
| Give the items in order, and `"due"`        | An activity reads the items after `seq`. `condition()` waits for the wake signal or the time.     |
| `"park"` at a limit                         | `next()` returns `"park"` when `workflowInfo().continueAsNewSuggested` is true.                   |
| Keep the record and `throughSeq`            | The workflow keeps them in variables. Temporal replays the history to make them again.            |
| Continue from the last record               | `continueAsNew()` with the last record and `throughSeq`                                           |
| `now()`, `all()`, and `claim()` are durable | `Date.now()` and `Promise.allSettled()` are deterministic in the sandbox. `claim` is an activity. |
| Interrupts and the stream                   | `storeDurable()` gives both from the store.                                                       |
| A turn yields before its deadline           | The deadline is the end of the activity time limit.                                               |

A history has limits: 51,200 events, 50 MB, and 10,000 signals. A payload has a limit of 2 MB.
Thus the workflow continues as new before its history is at a limit. Each step result is smaller
than `SESSION_LIMITS`.

### The files

```text
agent/
  agent.ts
  platform.ts
  lib/temporal-engine.ts    # Durable: the store, the Temporal client, and the worker of each replica
  lib/session-workflow.ts   # The Temporal workflow: the session program in the sandbox
  lib/postgres-store.ts     # A SessionStore on PostgreSQL
Dockerfile
```

```ts title="agent/platform.ts"
import { definePlatform } from "eve/platform";

import { temporalEngine } from "./lib/temporal-engine";

export default definePlatform({
  // deployment and storage are the same as in the Postgres example.
  durable: () =>
    temporalEngine({
      address: process.env.TEMPORAL_ADDRESS!,
      namespace: "support-agent",
      taskQueue: "eve-sessions",
      databaseUrl: process.env.DATABASE_URL!,
    }),
});
```

```ts title="agent/lib/temporal-engine.ts"
import { fileURLToPath } from "node:url";
import { Context } from "@temporalio/activity";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  registerCleanup,
  sessionSteps,
  storeDurable,
  type DurableEngine,
  type SessionSteps,
  type SessionStore,
} from "eve/platform";
import type { DeliveryAddress, SessionRecord, SessionStepName } from "eve/session";

import { postgresStore } from "./postgres-store";
import { sessionWorkflow, wakeSignal } from "./session-workflow";

export function temporalEngine(options: {
  address: string;
  namespace: string;
  taskQueue: string;
  databaseUrl: string;
}): DurableEngine {
  return {
    async start(app) {
      const store = postgresStore(options.databaseUrl, app);
      const connection = await Connection.connect({ address: options.address });
      registerCleanup(app.lifetime, () => connection.close());
      const client = new Client({ connection, namespace: options.namespace });

      const { durable, interrupts, streams, content } = storeDurable({
        store,
        wake: async (sessionId) => {
          await client.workflow.signalWithStart(sessionWorkflow, {
            workflowId: sessionId,
            taskQueue: options.taskQueue,
            args: [sessionId],
            signal: wakeSignal,
          });
        },
      });
      const steps = sessionSteps(app, { streams, interrupts, content });

      const worker = await Worker.create({
        connection: await NativeConnection.connect({ address: options.address }),
        namespace: options.namespace,
        taskQueue: options.taskQueue,
        workflowsPath: fileURLToPath(new URL("./session-workflow.ts", import.meta.url)),
        activities: engineActivities(store, steps),
      });
      const polling = worker.run();
      registerCleanup(app.lifetime, async () => {
        worker.shutdown();
        await polling;
      });

      return durable;
    },
  };
}

function engineActivities(store: SessionStore, steps: SessionSteps) {
  return {
    step: (name: SessionStepName, input: unknown, key: string, sessionId: string) => {
      const { attempt, startToCloseTimeoutMs } = Context.current().info;
      const deadline = Date.now() + startToCloseTimeoutMs - 30_000;
      return steps.run(name, input, { key, sessionId, attempt, deadline });
    },
    loadRun: async (sessionId: string) => (await store.loadRun(sessionId))!,
    itemsAfter: (sessionId: string, seq: number) => store.itemsAfter(sessionId, seq, 1),
    claim: (sessionId: string, addresses: readonly DeliveryAddress[], takeOver: boolean) =>
      store.claim(sessionId, addresses, takeOver),
    saveRecord: (sessionId: string, record: SessionRecord, throughSeq: number) =>
      store.saveRecord(sessionId, record, throughSeq),
  };
}

export type EngineActivities = ReturnType<typeof engineActivities>;
```

```ts title="agent/lib/session-workflow.ts"
// This module runs in the workflow sandbox of Temporal: no Node API, no I/O, and no app.
import * as wf from "@temporalio/workflow";
import { runSession, type SessionHost, type SessionRecord } from "eve/session";

import type { EngineActivities } from "./temporal-engine";

const act = wf.proxyActivities<EngineActivities>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "1 minute",
});

export const wakeSignal = wf.defineSignal("eve.wake");

export async function sessionWorkflow(
  sessionId: string,
  carried?: { record: SessionRecord; throughSeq: number },
): Promise<void> {
  let wakes = 0;
  wf.setHandler(wakeSignal, () => void wakes++);

  const loaded = await act.loadRun(sessionId);
  let record = carried?.record ?? loaded.record;
  let throughSeq = carried?.throughSeq ?? loaded.throughSeq;
  let readSeq = throughSeq;

  const host: SessionHost = {
    step: async (name, input, key) => {
      for (;;) {
        const result = await act.step(name, input, key, sessionId);
        if (!("yielded" in result)) return result;
      }
    },
    next: async ({ until } = {}) => {
      for (;;) {
        if (wf.workflowInfo().continueAsNewSuggested) return "park";
        const [item] = await act.itemsAfter(sessionId, readSeq);
        if (item !== undefined) {
          readSeq = item.seq;
          return item;
        }
        const seen = wakes;
        if (until === undefined) await wf.condition(() => wakes !== seen);
        else if (!(await wf.condition(() => wakes !== seen, Math.max(0, until - Date.now()))))
          return "due";
      }
    },
    now: () => Date.now(),
    all: (work) => Promise.allSettled(work),
    claim: (addresses, { takeOver }) => act.claim(sessionId, addresses, takeOver),
    adopted: async (next, consumed) => {
      record = next;
      throughSeq = consumed.throughSeq;
      await act.saveRecord(sessionId, next, consumed.throughSeq);
    },
  };

  const result = await runSession({ start: loaded.start, record }, host);
  if (result.kind === "parked") {
    await wf.condition(wf.allHandlersFinished);
    await wf.continueAsNew<typeof sessionWorkflow>(sessionId, {
      record: result.record,
      throughSeq,
    });
  }
}
```

`postgresStore()` is a `SessionStore` on PostgreSQL. The stream lines have the session ID and the
position of the line as the primary key. The inbox has the session ID and `seq` as the primary key,
and a unique item ID. A store of this type can be in its own package, and many engines can use it.

`saveRecord` also keeps the record in the store. Thus a new workflow, for example after the
operator ends one, can load the session again from the store. The worker bundles
`session-workflow.ts` with webpack when it starts. Thus the image must have that module as a file.

This table shows where each part fits into the design:

| Code                                | Part of the design                                                        | Caller                            |
| ----------------------------------- | ------------------------------------------------------------------------- | --------------------------------- |
| `temporalEngine()` in `platform.ts` | The `durable` field: a `DurableEngine` that the platform writes           | Phase 5 of the lifecycle          |
| `storeDurable()` in `start()`       | `Durable`, the interrupts, and the stream sink, from the store            | The session runtime of eve        |
| The `wake` function                 | `signalWithStart()`: it starts the workflow, or it wakes it               | `Durable.start()` and `deliver()` |
| `postgresStore()`                   | The `SessionStore`                                                        | `storeDurable()` and activities   |
| The worker in `start()`             | Engine code: it runs `sessionSteps()` with the app as activities          | Temporal, for each activity       |
| `sessionWorkflow()`                 | Engine code: `runSession()` in the workflow sandbox, with a `SessionHost` | Temporal, for each workflow       |
| `registerCleanup()` in `start()`    | The worker and the connection end with the lifetime of the app            | `endLifetime()` at shutdown       |

### Boot and calls

1. `eve build` reads the declaration. It builds the Node server. The engine opens nothing at build.
2. A replica starts. Phase 5 calls `temporalEngine().start(app)`. The engine connects to Temporal,
   and it starts a worker on the task queue.
3. A user sends a message. The route calls the session runtime, which calls `Durable.deliver()`.
   The store finds the session through its address and adds the item. Then `wake` sends the signal.
4. `sessionWorkflow()` wakes. `next()` reads the item from the store, and the program calls the
   `turn` step. Temporal runs the step as an activity on a replica. The step writes its stream lines
   to the store, and it reads the interrupts from the store.
5. After each step, the program calls `adopted()`. The workflow keeps the record and `throughSeq`.
6. When the history is long, `next()` returns `"park"`. The program returns `"parked"`, and the
   workflow continues as new with the record and `throughSeq`.
7. A client reads the stream route. The session runtime calls `Durable.readStream()`, which reads
   from the store. The NDJSON lines, positions, and leases are the same as on Vercel.

### What is not ready

| Part                                        | Status                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sessionProgram()`, `sessionSteps()`, store | Not built (next step 4). The record contract is in #6752.                                                                 |
| The sandbox module                          | Next step 4 removes the platform layer and the guarded fetch from the program.                                            |
| Step data                                   | `TurnStepInput` has a stream and two signals today. Step 4 moves them to the stream sink and to `poll()`.                 |
| Authored workflows                          | This engine has no `runs`. An agent with authored workflows does not build for this platform.                             |
| New versions of eve                         | The workflow must compare the hash of the session code before a replay. On a change, it continues as new from the record. |
| The engine of this example                  | Not written. The session battery must pass on it.                                                                         |

## Invariants

The sections above state each rule. This table gives the check that keeps each invariant. Two
invariants have no other section: an eve module does no I/O, sets no timer, and makes no random
value when it loads. New state for one application is a value of the app, not a new
`Symbol.for("eve.*")` global.

| Invariant                                                                                                      | Check                                                                                             |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No code finds an app through a global. Only the generated Workflow step functions read the app of the process. | Guard rule 72, changed in step 3                                                                  |
| The lifecycle is one ordered list, with rule 33 at its position                                                | A test of the order, and guard rule 33                                                            |
| Generic code does not read `VERCEL*` variables or import Vercel SDKs                                           | Guard rule 69                                                                                     |
| Code outside `src/platform/` imports only the entity interfaces and the built-in value modules                 | Guard rule 70                                                                                     |
| Only the Workflow engine uses a World                                                                          | Guard rule 71                                                                                     |
| The session program does not import Workflow                                                                   | Guard rule 66                                                                                     |
| The session program loads without Node                                                                         | Guard rule 65, with the `eve/session` entry                                                       |
| The program imports no step function, and reads no clock and makes no race outside `SessionHost`               | A new guard rule for the modules of rule 66                                                       |
| Each engine keeps the engine rules                                                                             | The session battery                                                                               |
| A run of the Workflow engine replays only on the same eve code                                                 | The step IDs, the guard with its classes, and a type that needs a class for each workflow (#6754) |
| The program replays its own runs                                                                               | A replay test on a test World                                                                     |

## Implementation

The engine boundary comes from earlier work: the session core without Workflow (#6053) and the
session battery (#6352).

These pull requests implement the first part of this design. Each change is internal and has a
patch changeset.

1. The platform layer, the move of Vercel OIDC route auth, and guard rules 69 and 70 (#6661).
2. The eve runtime with fixed slots, the durable boundary, definitions that resolve defaults at
   first use, and guard rules 71 and 72 (#6693).
3. Host services, the deployment scope, the session event store, and a test that installs a
   self-hosted platform (#6714).
4. A guard for outbound requests that checks the runtime before its first request, and two
   modules that do no work when they load (#6736).
5. The session record from #6455: the loop reports its open turn to a host that keeps sessions,
   and it continues a turn from the record (#6752).
6. The session core and harness without most Node built-ins and globals, from #6074. The modules
   that are different for each runtime are in `src/runtime-env/` (#6753).

These changes do not have the app or the entities yet. A platform sits in one process slot,
and leaf code reads it through `platformContext()`. The services use a `hostServices()` builder, and
the runtime has fixed slots instead of names.

## Next steps

These steps are internal:

1. **The app and the lifecycle.** Add `eve:app`, `start()`, `App`, lifetimes, and the ordered
   list of phases. Boot does the same work in the same order. The fixed runtime slots become values
   of the app.
2. **The platforms of eve.** Add `definePlatform()` and the nine entities. Declare the Vercel
   platform and the default platform with them, and move the Vercel concepts into the Vercel
   declaration. eve does not load `agent/platform.ts` before step 6. Remove
   `PlatformContext` and `hostServices()`.
3. **Entry points and defaults.** Let each entry point start the app or receive it, and generate
   the Workflow step functions that read the app of the process. Today
   `defineDynamicSchedules()` and `defineWorkspaceAgent()` read the platform when an author calls
   them. Move these reads, and the defaults of `DefaultSandbox` and
   `fileMemory()`, into the code that uses the definitions. Remove `platformContext()`, and
   change rule 72. Add the scenario test for the Workflow step functions.
4. **`Durable`.** Replace `DurableHost` with `Durable` and `workflowEngine()`. Make the session
   runtime from `Durable`. Split the session program (`sessionProgram()`) from the work of the
   steps (`sessionSteps()`), and put each step behind `SessionHost.step()`. Add the interrupts,
   `StepMeta`, the content store, `SessionStore`, and `storeDurable()`. Use the record of #6752 as
   the contract of an engine. Remove the Node APIs that #6753 leaves in the session program, and
   add the guard rules of the program. Stamp the hash of the session code on each run, and let the
   guard compare it. A replay test restarts a test World at a parked, a paused, and an idle
   session, and it finds no replay divergence. The lookups in `execution/hosts.ts` become values of
   the app.
5. **A platform outside eve.** Add `Build.entry`, `Build.conditions`, `BuildContribution.entries`,
   and the checks of the runtime. A build with an entry uses the `standard` preset of Nitro, which
   makes a module with only a `fetch` handler. The entry module becomes the Nitro entry, and the
   build maps `eve:app` and `eve:instrumentation` to the built modules. A spike showed this
   mechanism for one entry. It did not build a second entry, and it did not run outside Node. Write
   the platforms of the Cloudflare and Temporal examples in their own packages, and run the session
   battery on each. The battery of the Cloudflare platform runs in the Workers runtime. This step
   tests the boundary.

This step comes after the internal steps:

6. **Platform selection.** An application must tell eve which platform it uses. This is the first
   public API. This design proposes `agent/platform.ts`, which eve then loads. A build option is the
   alternative. This decision needs its own review.

## Open questions

- Can a platform build on another, for example a base for one host with changes for one
  application?
  This design permits one declaration and no merge.
- Which parts of the engine contract become public API? An engine that a platform writes needs
  `Durable`, `sessionProgram()`, `runSession()`, `sessionSteps()`, `SessionHost`,
  `SessionStore`, `storeDurable()`, and the opaque `SessionRecord`. If the Workflow runtime can
  run without Node, the Cloudflare platform can give only a World. The Temporal platform needs these
  parts in each case.
- Authored workflows (`eve/workflow`) and workflow tool runs are a second program, with their own
  host (`RunHost` in `execution/run-host.ts`). Can eve compile each authored `"use workflow"` body
  to a generator of the same commands? Each `"use step"` call becomes a `step` command, with the
  export name as its name and the call order as its key. `sleep()` becomes `next({ until })`, and
  a hook becomes a delivery to an address of the run. Then each engine can run authored workflows,
  and `Durable.runs` goes away. But then authored code must keep the rules of the program: no clock,
  no race, and no Node. eve checks these rules only for its own code.
- How does a platform with `Triggers` receive the authored schedules? Two options are a call at
  boot and a step at build.
- The public API uses the word "world" in `experimental.workflow.world` and in about 18 docs pages.
  Which eve name replaces it?
- The `DefaultSandbox` option for a hosted sandbox is `vercel`. Which neutral key replaces it for
  other platforms?
- Nobody measured the cold start before and after this work. Is a measurement necessary before
  platform selection?

## Appendix: where the current contract goes

| Current member                                                                               | Entity                          |
| -------------------------------------------------------------------------------------------- | ------------------------------- |
| `environmentKind`, `deploymentId`, `productionHost`, `publicHost`, `deploymentHost`, `scope` | `Deployment`                    |
| `hostedDeploymentId`, the `vercelDeploymentId` invocation field                              | `Deployment.invocationData`     |
| `DurableHost`, the World, the queue namespace                                                | `Durable`                       |
| `scheduleProvider`                                                                           | `Triggers`                      |
| `hostedSandbox`, `stopsSandboxesOnExit`                                                      | `Compute`                       |
| `documentStore`                                                                              | `Storage`                       |
| `isPlatformIssuer`, `acceptCurrentVercelProject`, `withDevelopmentRequestScope`              | `Identity`                      |
| `callbackHeaders`, `workspace.transport`, `token`                                            | `Network`                       |
| `agentRuns`, `traceSessionAttribute`                                                         | `Telemetry`                     |
| `build.target`, `outputDirectory`, `buildOutput`, `localSandboxPrewarmFailure`               | `Build`                         |
| `isPlatformDevelopmentServer`                                                                | Inside the Vercel platform only |
