---
issue: https://github.com/vercel/eve/pull/6661
status: in-progress
last_updated: "2026-11-24"
---

# Platforms for eve

## Summary

eve already runs on platforms other than Vercel. An example is a self-hosted Node server with the
Postgres World. But only Vercel has a formal contract. On other platforms, eve depends on its
defaults and on code that knows Vercel. The goal is a formal contract that each platform can
implement, for example a Kubernetes cluster or a runtime that has no Node process.

This document gives the design for that goal:

- **A platform is one file.** `agent/platform.ts` has a `definePlatform()` declaration. The
  declaration gives nine generic entities, for example `Compute`, `Storage`, and `Models`, and a
  durable engine. Each entity answers one question that eve asks. Generic code uses the entities
  and never asks which platform it runs on.
- **An application instance is a value.** The compiler builds `eve:app`, and its `start()` returns
  an app. The code that calls `start()` gives the app to the code that it calls, so no code finds it
  through a global. Two apps in one process share no state of an app.
- **eve runs a fixed lifecycle.** The order of the phases is a list. The author of a platform
  writes no order.
- **`Durable` hides the engine.** eve ships the Workflow engine, and a platform can write its own.
  Thus a platform can run eve without Workflow.

Three examples show the design in use. The first is a self-hosted Node server with the Postgres
World. The second uses only Cloudflare products, without Workflow. The third uses Temporal as the
durable engine. A platform for another host is in its own package, outside this repository.

The public API is experimental. `eve/experimental/platform` exports `definePlatform()`, the
entities, and the engine contract. `eve/experimental/session` exports the session program for an
engine that a platform writes. Without `agent/platform.ts`, eve uses its built-in Vercel
declaration, and the behavior on Vercel does not change. The user docs are in
[Platforms](../docs/experimental/platforms.md).

The next section explains the background. A reader who knows eve and durable execution can go to
"Problem".

## Background

This section is for a reader who knows TypeScript servers, but not eve or durable execution.

### How eve runs an agent

An agent is a directory of files: instructions, tools, channels, and schedules. `eve build`
compiles the directory into a server. A message from a channel, for example Slack or HTTP, goes to
a route of that server.

The route sends the message to a session. A session is one conversation. It can last for days, and
it waits for messages between its turns. A turn calls the model and the tools until the agent
replies. A tool can run code in a sandbox, read memory, or call another agent.

```text
channel ──► route ──► session runtime ──► durable engine ──► session program
                                               │                    │ step("turn", …)
                                               ▼                    ▼
                                      storage of the engine      steps ──► sandbox, memory, model,
                                                                            other agents, traces
```

### Why sessions need a durable engine

A process can stop at any time, for example at a crash or a deploy. A session must continue after
that, and it must not do its work two times. For example, it must not send one reply two times.

A durable engine gives this property. eve writes each session as a program of steps. The engine
keeps the result of each step. After a stop, the engine runs the program again. A step that has a
kept result returns that result, and it does not run again. This is a replay. The program must make
the same calls in the same order at each replay. Thus it reads no clock and makes no race outside
the engine.

Today the engine is the Workflow SDK. Workflow keeps its state in a "World": the local World on
disk, the Postgres World, or the Vercel World. Other products do the same work, for example
Temporal, Restate, and Inngest.

### What eve needs from the host

eve also asks questions that only the host can answer. Which deployment is this? Where does
untrusted code run? Where does memory stay? Who calls in? How does eve call out? Where do traces
go? Where do model credentials come from? How is the application packaged?

On Vercel, eve knows the answers. On other hosts, eve uses defaults, or the author gives a value to
each definition. This design calls the set of answers a platform.

### Terms

| Term                           | Meaning in this document                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `definePlatform()` declaration | The file that gives the answers for one host                                         |
| Entity                         | One part of a platform that answers one question, for example `Compute`              |
| App                            | One started instance of the application: its platform, its engine, and its lifetime  |
| Lifetime                       | The cleanups that run when an app or a session stops                                 |
| Durable engine                 | The code that makes sessions continue after a stop. eve uses it through `Durable`    |
| World                          | The storage of the Workflow SDK. Only the Workflow engine uses this word             |
| Session program                | The code of one session, from its start to its end. It runs on the engine            |
| Step                           | One durable unit of work of the session program, for example a turn                  |
| Step 1 to step 6b              | A part of the plan of this document. A step with a number is never a durable step    |
| Delivery and address           | A message to a session. The address identifies the session that receives it          |
| Park                           | The session stops its run when it has no work. The next delivery continues it        |
| Record                         | The data that a run keeps, so that the next run can continue the session             |
| Entry build                    | A build for a runtime with no Node server. A module of the platform handles requests |

## Problem

On `main`, eve has these problems:

1. **Boot order is implicit.** Generated modules run in import order. Each module puts its result
   into a process global, for example the hosts registry (`Symbol.for("eve.hosts")`) and the
   default runtime session. Code that runs later reads the globals back.
2. **Generic code knows Vercel.** 41 modules in `packages/eve/src` read `process.env.VERCEL*`. They
   include the Nitro host, tracing, the application build, channel auth, and the workspace agent.
   Generic modules also import `@vercel/sandbox`, `@vercel/oidc`, and `@vercel/functions` directly.
3. **No type says what a platform gives.** A host that eve does not ship can give its own sandbox,
   document store, schedules provider, or model credentials. It can do this only through the
   options of each definition. It cannot give defaults for the whole application.
4. **The durable contract has the shape of Workflow.** `DurableHost` in `execution/hosts.ts` has
   nine members. `runStatus()` and `cancelRun()` take a Workflow run ID, and `stepAttempt()` reads
   the current Workflow step. `installDurableHost()` puts the host into the process global.
5. **State is for one process, not for one application.** Two applications, two eve copies, or two
   tests in one process share the hosts registry and the runtime session storage.

## Writing a platform

### The platform file

A platform is one file, `agent/platform.ts`. Its default export is a declaration from
`definePlatform()`, which `eve/experimental/platform` exports:

```ts
function definePlatform<C = undefined>(fields: {
  context?(): C | Promise<C>;
  deployment(app: PlatformApp, context: C): Deployment;
  durable?(): DurableEngine<C>;
  triggers?(app: PlatformApp, context: C): Triggers;
  compute?(app: PlatformApp, context: C): Compute;
  storage?(app: PlatformApp, context: C): Storage;
  identity?(app: PlatformApp, context: C): Identity;
  network?(app: PlatformApp, context: C): Network;
  telemetry?(app: PlatformApp, context: C): Telemetry;
  models?(app: PlatformApp, context: C): ModelCredentials;
  build?: Build;
}): PlatformDeclaration<C>;

interface PlatformApp {
  readonly platform: Entities; // the other entities of the app
  readonly lifetime: Lifetime; // the lifetime of the app, for the cleanups of a factory
}
```

Rules:

- `definePlatform()` returns inert data with a brand. The compiler finds `agent/platform.ts` by its
  path. When the file exists, eve selects it. Else eve selects its built-in Vercel declaration.
- A default export that is not a `definePlatform()` declaration stops the build. The error names
  the file, and it tells the author to export the result of `definePlatform()` or to delete the
  file.
- The application has one platform declaration. It cannot merge two declarations.
- Each field is a factory for one entity. The field names are the only names that an author
  writes. Other files of the platform are ordinary modules, for example in `agent/lib/`.
- The fields have no order. A factory that needs another entity reads it from `app.platform`, and
  eve makes that entity first.
- `context()` gives the values that exist only at run time, for example the bindings that a
  runtime gives to a request handler. eve calls it one time for each app, and it gives the
  result to each factory and to `DurableEngine.start()`.
- The build calls no `context()` and no factory. It reads only `build` and the `build` of the
  engine that `durable()` returns. `build` can hold functions, for example
  `Build.prewarm.failure`, but neither `build` nor `durable` receives the context. Thus the types
  stop a build from a read of run-time values. `durable` returns data and functions, and it opens
  no resource.
- `agent/platform.ts` loads in two places: the build, which is Node, and the server. Thus it does
  not import, at the top level, a module that only one of them has. It loads such a module in
  `context()`. The build loads it with the loader of authored modules, so it takes the same
  imports as the other files of the agent.
- The Vercel facts that generic modules read from `VERCEL*` variables on `main` are in the
  built-in Vercel declaration. Thus the behavior on Vercel does not change.
- In the server, only the generated platform module imports the selected declaration. `eve start`
  serves the declaration that the build selected.
- `eve dev` also loads `agent/platform.ts`. It keeps the platform that it started with until a
  restart of `eve dev`.

### The entities

Each entity answers one question that eve asks:

| Entity       | Question                                            | When the platform does not give it                                                                                                  |
| ------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `Deployment` | Where and what is this deployment?                  | Not permitted. `createEntities()` stops with an error.                                                                              |
| `Triggers`   | Which service keeps and fires schedules?            | Authored schedules run as Nitro scheduled tasks in the server process. `defineDynamicSchedules()` needs its own `provider`.         |
| `Compute`    | Where does untrusted code run?                      | No hosted sandbox. `DefaultSandbox` uses Docker if a Linux Docker daemon is there, then `just-bash` in `eve dev`. Else it has none. |
| `Storage`    | Where do memory documents stay?                     | `fileMemory()` uses the development store in `eve dev`. In other places, it needs its own `backend`.                                |
| `Identity`   | Who calls in?                                       | OIDC route auth verifies the token and the claim matchers. It does not accept callers from the current project without matchers.    |
| `Network`    | How does eve call this deployment and other agents? | No callback headers and no token. `defineWorkspaceAgent()` needs its own `transport`.                                               |
| `Telemetry`  | Where do traces go?                                 | Only the instrumentation of the agent. Spans have no session attribute.                                                             |
| `Models`     | Where do model credentials come from?               | The model needs an AI Gateway API key in its configuration.                                                                         |
| `Build`      | How is the application packaged?                    | The Node server of eve, with the `node-server` preset.                                                                              |

`Triggers` is the model for schedules. Its `schedules` member is the default `provider` of
`defineDynamicSchedules()`. When `build.schedules.authored` is `true`, its `register()` receives the
authored schedules of `agent/schedules/` at boot.

The durable engine comes from the `durable` field of the declaration. Without `durable`, eve starts
its default engine: the Workflow engine, with the World from `agent.ts` or the local World. The
Vercel declaration has no `durable`, so it uses this default. OIDC route auth and the default
transport of a workspace agent read the entities of the app.

```ts
interface Deployment {
  environment(): "development" | "preview" | "production" | undefined;
  deploymentId(): string | undefined;
  publicHost(): string | undefined;
  productionHost(): string | undefined;
  scope(): DeploymentScope | undefined;
  invocationData?(): Readonly<Record<string, string>>;
  revision?(): DeploymentRevision | undefined; // the deploy time, the Git branch, and the Git SHA
  localDevelopment?(): boolean;
}

interface DurableEngine<C = undefined> {
  readonly build?: BuildContribution; // data that the build reads
  start(app: EngineApp, context: C): Durable | Promise<Durable>; // opens resources at run time
}

type EngineApp = Pick<App, "platform" | "lifetime" | "hosts">;

interface Triggers {
  readonly schedules: ScheduleProvider;
  register?(schedules: readonly AuthoredSchedule[]): void | Promise<void>; // at boot, idempotent
}

interface AuthoredSchedule {
  readonly name: string; // from the path; runAuthoredSchedule() takes it
  readonly cron: string;
  readonly timezone?: string;
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
  verifyOidcCaller?(caller: OidcCallerInput): OidcCallerVerdict;
  developmentCaller?(caller: SessionAuthContext): boolean;
  developmentScope?<T>(
    input: { appRoot: string; request: Request },
    run: () => Promise<T>,
  ): Promise<T>;
}

interface OidcCallerInput {
  readonly issuer: string;
  readonly payload: OidcClaims; // iss, sub, aud, jti, nbf, exp, iat, and other claims
  readonly strategy: ResolvedOidcAuthStrategy;
}

interface Network {
  self?(url: string, isTrustedOrigin: (url: URL) => boolean): Readonly<Record<string, string>>;
  peer?(routePath: string): WorkspaceAgentTransport | undefined;
  token?(): Promise<string>;
  fetchUntrusted?(request: Request): Promise<Response>; // where the guard of eve cannot run
}

interface Telemetry {
  spanProcessor?(): SpanProcessor;
  readonly sessionAttribute?: string;
}

interface ModelCredentials {
  resolve(rejectedToken?: string): Promise<DevelopmentModelCredential>;
}

interface Build {
  readonly prewarm?: BuildPrewarm; // the sandbox prewarm of the build
  readonly schedules?: {
    readonly kind?: string; // the default kind of a schedule provider
    readonly authored?: boolean; // Triggers runs the authored schedules
  };
  readonly entry?: string; // a module of the platform that starts the app and serves it
  readonly conditions?: readonly string[]; // the export conditions of the runtime of the entry
  platformOutput?(): boolean; // the build writes the output format of the platform
  outputDirectory?(appRoot: string): string | undefined;
}

interface BuildPrewarm {
  readonly compute: Compute; // the hosted sandbox for prewarm and for sandboxes at compile time
  failure?(providerName: string, error: unknown): Error | undefined; // explains a local failure
}
```

Some types are eve code of today: `ScheduleProvider`, `MemoryDocumentBackend`, `SandboxEnvironment`,
`SpanProcessor`, `WorkspaceAgentTransport`, `DevelopmentModelCredential`, `ConnectionEventOwners`,
`ToolStubHost`, `SessionMoves`, `SessionStrandedError`, and the session `Runtime`.
`HostedSandboxOptions` is the `VercelSandboxCreateOptions` of today. OIDC route auth verifies the
token, and then it gives `verifyOidcCaller()` the issuer, the claims, and the strategy of the
route. The claims are an `OidcClaims`, which is a type of eve, not the type of the JWT library. The
verdict accepts the caller, refuses it, or lets the route auth continue. Other types are new, and
this document defines them.

Some shapes stay as they are today, because a new shape changes the behavior.
`productionHost()` and `publicHost()` return hosts, not origins. `Network.self` keeps the check of
trusted origins. `Telemetry.spanProcessor()` returns one processor.

Rules:

- A feature that only some platforms have is an optional member of its entity. Examples are
  `ProgramHost.moves`, `Compute.credentialTransforms`, and `Network.peer`. Generic code does not
  compare platform names.
- `Identity` is only for calls that come in. `Network` is only for calls that go out. Thus
  `Network` has the headers for a callback to this deployment and the transport to a workspace
  agent. It also has the token that eve shows to another service.
- `Network.fetchUntrusted` fetches an untrusted URL, for example a `web_fetch` target or a session
  callback. eve uses it only where its guard refuses because the runtime has no guarded `fetch`.
  Without it, eve still refuses the request.
- `Triggers` starts work at a time. When a dynamic schedule comes due, the provider calls
  `deliverScheduleOccurrence(app, { payload, occurrence })` with the payload that its `create()`
  kept. When an authored schedule comes due, `Triggers` calls `runAuthoredSchedule(app, name)`. Both
  run in any process of the app, and both reach the session through `Durable`. Thus a platform can
  use a schedule product with any engine.
- With `build.schedules.authored`, the build adds no scheduled tasks of its own. The `triggers`
  phase gives the authored schedules to `Triggers.register()` in each process, except in `eve dev`,
  which keeps its local scheduler. Without `register()`, that phase stops with an error.
- `Build` is the only entity that eve reads at build time. `DurableEngine.build` adds to it, for
  example the entries of an engine that a platform writes.
- `Build.prewarm` holds the two parts of the sandbox prewarm. `compute` is the hosted sandbox,
  because the build never calls the `compute` factory. Prewarm uses it, and `DefaultSandbox` uses
  it to select its provider when the compiler reads a sandbox. `failure` is optional. It returns an
  error that explains why a local provider fails in the build of the platform.
- `Build.schedules` is build data because the compiler never calls the `triggers` factory. The
  compiler writes its `kind` for a `defineDynamicSchedules()` that has no `provider`. The build
  reads `authored` to decide whether it adds scheduled tasks.
- eve validates each entity when it makes it. For example, `Compute.name` cannot be a name that
  `DefaultSandbox` uses for its own providers.
- A value that an author gives comes first. When an author gives no value, for example no
  `provider` in `defineDynamicSchedules()`, eve reads the entity when it uses the definition. A
  `define*` function reads no entity. A public getter reads the entity of the app when code reads
  the getter, not when the module loads. Examples are `defineDynamicSchedules().provider`, and the
  default `url` and `auth` of a workspace agent. The deployed self-modification sandbox also makes
  its hosted environment at its first use.
- The Vercel concepts are in the Vercel declaration only. For example, the Vercel `Identity`
  verifies `acceptCurrentVercelProject`, and the Vercel `Deployment` adds `vercelDeploymentId` to
  invocation data.

### The entry

`Build.entry` tells eve how the application is served:

- The build reads the selected declaration: `agent/platform.ts`, or else the built-in Vercel
  declaration. A build option for tests selects a different module.
- Without `entry`, eve serves the application with its own Node server, as `eve start` does today.
- With `entry`, eve builds `eve:app` with the `standard` preset of Nitro. Only an entry build uses
  this preset. The module in `entry` imports `start` from `eve:app`, starts the app, and serves
  `app.fetch()`. `waitUntil` keeps the work of a channel after the response, where the runtime
  permits it. `eve:app` makes its `fetch` from the Nitro app, not from the entry of the preset.
- `start()` from `eve:app` stops with an error at a second call. It also stops when the entry did
  not import `eve:instrumentation` first, and when the runtime has no `AsyncLocalStorage`.
- The entry module imports `eve:instrumentation` before `eve:app`. In an entry build, this module
  has no top-level `await`. It starts the platform phase, and it registers the providers when that
  phase ends. Phase 6 of `start()` waits for this setup. In a Node server build, the module waits
  for the platform phase and the setup when it loads.
- `conditions` gives the export conditions of the runtime to the build. Without the `node`
  condition, the build selects the web version of each module in `src/runtime-env/`, and it sets
  the platform of rolldown to `neutral`. The Node built-ins stay external. `conditions` without
  `entry` stops the build. Generic code does not read `conditions`.
- A file or an export that a host needs comes from the entry module. eve does not know these files
  and exports.
- The Vercel declaration uses an entry that is internal to eve. It keeps the Vercel output, so the
  limits below do not apply to it.
- A platform for a host other than Vercel is in its own package. The code of eve does not name such
  hosts.

An entry build has no server of its own. `eve start` refuses it. An entry build does not have these
parts of the Node server:

| Part                | Without the Node server                                                          |
| ------------------- | -------------------------------------------------------------------------------- |
| WebSocket upgrade   | A channel route with the `WEBSOCKET` method stops the build with an error.       |
| The schedule runner | With `build.schedules.authored`, `Triggers` runs them. Else they stop the build. |
| Connection drain    | The host of the entry ends the open requests at shutdown.                        |

An engine can add entry modules through `BuildContribution.entries`, for example a handler that
its product calls. Each one is an output file, `server/<name>.mjs`, beside the main entry. It can
import `start` from `eve:app`. `entries` is valid with or without `Build.entry`, because a Node
server build also makes `eve:app` from the Nitro app. The name `index` is the name of the main
entry, so it stops the build. When two entries load in one process, they import one module that
calls `start()`.

At run time, the app starts the engine of the declaration that the build selected. Thus an output
that the build made with another engine serves requests on that engine. A scenario test shows this
with an engine on `storeDurable()`.

eve does not ask a platform which runtime it uses. Each part that needs a feature of the runtime
checks for the feature itself, and it stops when the feature is not there:

| Part                            | Check                                                                                                                                                         | When the check fails                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The local World                 | It finds a disk when the engine starts.                                                                                                                       | The engine does not start. The error tells the author to add `durable`.                      |
| The guard for outbound requests | Before its first request, it calls `fetch` with a test dispatcher that stops the call. The result shows if `fetch` uses the guard. No request goes to a host. | eve sends the request through `Network.fetchUntrusted`. Without it, eve refuses the request. |
| The context storage of eve      | The web version of `#runtime-env/async-storage` uses the global `AsyncLocalStorage` of the runtime when it exists.                                            | `start()` from `eve:app` refuses to serve.                                                   |

Without `AsyncLocalStorage`, eve keeps one current scope for all requests. Thus concurrent requests
can act with the identity of a different request. That storage stays only for hosts with one user,
for example a browser, which never call `start()`.

### Out of scope

The route of model calls, for example through AI Gateway, is a separate change. The `models`
entity gives only the credentials.

## How eve runs a platform

### The app

```ts
// eve:app is built by the compiler from the agent directory and agent/platform.ts.
export function start(): Promise<App>;

interface App {
  readonly platform: Entities; // the entities by field name; each is made at its first read
  readonly durable: Durable; // the started engine
  readonly hosts: AppHosts; // the hook routes and the session streams
  readonly lifetime: Lifetime; // ends when the app stops
}

interface AppHosts {
  readonly routes: HookRoutes; // the hosted hook routes, and the route fallback of the engine
  readonly streams: SessionStreams; // the stream reader of each session, and of the engine
}

type RouteHosts = Pick<AppHosts, "routes">; // for code that uses only the hook routes
type StreamHosts = Pick<AppHosts, "streams">; // for code that uses only the session streams

// In an entry build, start() from eve:app returns only the handler of requests.
interface EntryApp {
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

- `start()` makes the app of its build and runs the lifecycle. A second call of `start()` from
  `eve:app` stops with an error that tells the caller to keep the first app. The built server is
  one module graph, so a second app from it cannot share nothing. The entry module keeps the
  promise of its first call. The internal `start()` of the Workflow boot accepts a second call, as
  the boot did before.
- Two apps in one process come from two builds, or from tests. A test starts an app from a test
  platform with the internal function under `start()`. Two such apps share nothing.
- The code that calls `start()` keeps the app, and it gives the app to the code that it calls.
  Routes import the app from the generated `#eve/route-app` module. Inside a turn, code reads the
  app from the context of the turn. This is the context storage that eve uses for all the state of
  a turn. A step reads `startedApp()`, the started app of `processApp()`. No code finds an app
  through a global or through `this`.
- Some code runs in a process that has no app. It reads the entities from `platform/process.ts`.
  The generated platform module registers the selected declaration there. eve makes the entities
  one time for each process, at the first read. Examples are the fallback of the Workflow engine,
  `resolveCurrentWorkflowDeploymentId()`, and `DefaultSandbox` outside a turn. Such code reads
  `builtInHosts()`. It returns `ProcessHosts`, which is the `AppHosts` of the process and also
  holds the process engine.
- A function that uses only the hook routes takes `RouteHosts`. A function that uses only the
  session streams takes `StreamHosts`. Only code that uses both takes `AppHosts`.
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

- Entity factories receive `PlatformApp`, which has the entities and `app.lifetime`. A resource
  that an entity opens registers its cleanup on `app.lifetime`, so it ends with the application.
  The lifetime exists before the platform phase. In a process that has no app, the factories
  receive a lifetime of that process. `DurableEngine.start()` also receives `app.lifetime`.
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
- `endLifetime(app.lifetime)` ends the open session lifetimes first. When the end of a session
  lifetime already started, it waits for that end. Then it runs the cleanups of the app, in the
  opposite order of registration. Every cleanup runs even if one fails, and the first error is
  rethrown at the end. A second call for one lifetime returns the same promise.
- Only eve makes a lifetime: one for each app, one for the platform of a process that has no app,
  and one for each session. The brand on `Lifetime` makes this a type error for other objects.
- Only the code that made a lifetime ends it.
- `openSession()` makes the lifetime of a session, but no production code calls it yet. Thus the
  sandbox shutdown stays a generated `#eve/` plugin, and that plugin receives the app.

A host that discards a process or an isolate without notice does not call `endLifetime()`. Thus
cleanup is not certain, and a platform does not depend on it for correct results.

### The lifecycle

`start()` runs one list of phases. The position in the list is the order:

| Phase                                | Reason for its position                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ |
| 1. Attach the declaration            | `context()` runs first, and each later phase can read the entities.      |
| 2. Set the queue namespace           | Rule 33: before any code makes queue messages.                           |
| 3. Install the compiled artifacts    | The agent directory and the sessions read them.                          |
| 4. Start the engine as `app.durable` | The Workflow engine reads `Deployment.deploymentId()`.                   |
| 5. Give schedules to `Triggers`      | It reads the entities and the artifacts. A due schedule needs `Durable`. |
| 6. Install the instrumentation       | It waits for the setup that `eve:instrumentation` started.               |

Phase 1 imports the declaration from the generated platform module. It calls `context()`, and it
makes the entities with the result. Phase 4 also sets the stream reader of the app over `Durable`
when the engine is not the process engine. Phase 5 calls `Triggers.register()` only when
`build.schedules.authored` is `true`, and never in `eve dev`. A test checks this order. Thus rule 33
and the order of the platform and the deployment ID are part of one list, not separate rules.

The agent directory loads after these phases. Thus each tool, channel, memory, and schedule sees
all entities.

A build does not start the app. It reads `build`, which includes `Build.prewarm` and
`Build.schedules`, and the `build` of the engine from `durable()`. It reads nothing else.

The Node server of eve starts its own plugins after `start()`: local schedules, skill files, and
connection drain. With `build.schedules.authored`, the build gives it no local schedules.

`eve dev` runs a shorter list. Its bootstrap installs only the platform and the queue namespace.
The compiled artifacts come from disk, and eve reads the snapshot pointer again at each read. The
engine uses the World that the `eve dev` parent process serves.

### Entry points

An entry point is code that a host calls. It holds an app, or it receives one from the code
that started it:

| Entry point                                 | How it has the app                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| The Node server and the Vercel entry of eve | The generated boot module calls the internal `start()` one time. At shutdown, a plugin calls `endLifetime()`. |
| HTTP request                                | The route handlers import the app from `#eve/route-app`. In an entry build, the entry calls `app.fetch()`.    |
| A platform entry module                     | It imports `start` from `eve:app`. It calls `start()` at the first request, and it keeps the promise.         |
| Engine or trigger code of a platform        | The engine keeps the app of its `start()` with its `Durable`, and it gives that app to `sessionSteps()`.      |
| Workflow step                               | A step body, or the wrapper of an authored step, reads `startedApp()`.                                        |
| Build                                       | It has no app.                                                                                                |
| OpenTelemetry                               | The instrumentation module runs the platform phase first. Then it registers the providers with the entities.  |
| Tests                                       | A test starts an app with a test platform, and it calls `endLifetime()` after the test.                       |

The Workflow SDK calls a step function with serialized input only. Thus eve cannot give the app to
a step as an argument. A process that runs Workflow steps has one app, so each step body reads it:

```ts
// A step function. Its name does not change, so its step ID does not change in one version of eve:
export async function runTurnStep(input: TurnStepInput) {
  "use step";
  return turnStep(startedApp(), input);
}
```

The step bodies are written by hand. `processApp()` and `startedApp()` are internal. Guard rule 72
lets only files with a `"use step"` directive and the named owner modules read them. A local
scenario test and the `agent-basic-runtime` eval show that a step receives the app. No fallback
exists, so a step reads only the app. The scenario test of step 6a serves a session on a test
declaration.

An engine can be process-wide. Examples are the Workflow engine and an engine on a library that
has one instance for each process. Such an engine records its app in `start()`, and it clears the
record in a cleanup on `app.lifetime`. When a second app starts it while the first app lives, it
stops with an error. Thus `DurableEngine` needs no flag for this case.

## Durable

This part of the design has five interfaces. Each interface has one user:

```text
generic eve code ──► Durable           starts a session, delivers a message, reads the stream
the engine       ──► runSession()      runs the session program
session program  ──► ProgramHost       step(), next(), now(), and all()
the engine       ──► sessionSteps()    does the work of one step, with the app
the engine       ──► storeDurable()    makes Durable and an inbox from a SessionStore
```

A platform that uses the Workflow engine needs only `Durable`. The other interfaces are for a
platform that writes its own engine.

`Durable` is the generic interface for durable work. Generic code uses only this interface. It does
not see a World, a queue, or how an engine keeps sessions:

```ts
interface Durable {
  start(session: SessionStartInput): Promise<SessionStartResult>;
  deliver(
    to: DeliveryAddress,
    payload: unknown,
    options?: { key?: string },
  ): Promise<DeliveryResult>;
  sessionFor(address: DeliveryAddress, options?: { live?: boolean }): Promise<string | undefined>;
  readStream(sessionId: string, from: number): AsyncIterable<StreamLine>;
  tail(sessionId: string): Promise<number>; // the last position, or -1 when the stream is empty
  status(sessionId: string): Promise<SessionStatus | undefined>; // can reject: SessionStrandedError
  readChildBinding?(sessionId: string, childSessionId: string): Promise<unknown>; // only with runs
  readonly connectionEvents?: ConnectionEventOwners;
}

type SessionStartResult =
  | { readonly kind: "started"; readonly sessionId: string }
  | { readonly kind: "held" }; // another session holds the continuation address

type DeliveryResult =
  | {
      readonly accepted: true;
      readonly sessionId?: string;
      readonly inbox?: string;
      readonly prewarm?: "ready" | "accepted" | "unsupported"; // the answer to a prewarm
    }
  | { readonly accepted: false; readonly reason: "inactive"; readonly cause: unknown }
  | {
      readonly accepted: false;
      readonly reason: "replace"; // a new session must replace this session
      readonly cause: SessionStrandedError;
      end(): Promise<string>; // ends the session, and returns its ID
    };

type SessionStatus = "running" | "parked" | "paused" | "ended" | "failed";

interface SessionStartInput {
  readonly sessionId?: string; // without it, the engine makes the ID
  readonly parentSessionId?: string;
  readonly addresses: readonly DeliveryAddress[]; // the engine claims these at the start
  readonly body: Opaque<"eve.session-start">; // the engine keeps it and does not read it
}

interface DeliveryAddress {
  readonly key: string; // eve makes the key
}

interface StreamLine {
  readonly position: number;
  readonly line: string; // one NDJSON line
}
```

- `sessionRuntime(durable, hosts, config)` makes the session runtime from `Durable` and the
  `StreamHosts` of the app, for each engine. It is the `Runtime` interface that channels and routes
  use. Thus each engine serves the same session protocol: NDJSON lines, line positions,
  `startIndex`, leases, and the tail index.
- The engine makes the session ID. `start()` returns it. A step can run more than one time, so a
  caller can give the ID. Then a second `start` with that ID does nothing. The Workflow engine
  receives its IDs from the World, which encodes the region in each ID.
- `deliver` does nothing when an item with the same key exists. It returns one of three results.
  `accepted` has the session ID. `inactive` tells that no session holds the address. `replace`
  tells that a new session must replace the session. Its `cause` is a `SessionStrandedError`, and
  its `end()` ends the session and returns the ID of that session.
- A prewarm is a session command, so it also goes through `deliver()`. An engine that can prewarm
  a session puts its answer in `prewarm` of the accepted result.
- `sessionFor()` finds the session of an address. With `live`, it returns only a session that can
  run. It rejects with a `SessionStrandedError` when a new session must replace the session.
- The Workflow engine decodes the address keys that eve makes. An engine that a platform writes
  does not parse a key.
- The Workflow engine keeps the work that is special to it behind these operations. "The Workflow
  engine" tells how.
- A cancel is a delivery to the address of the session. Thus `Durable` has no `cancel`.
- eve serves the stream routes from a `SessionEventStore`. It reads three slots in this order: the
  reader that an engine registers for one session through `hostEngine(app).session()`, the reader
  of the app, and the reader of the process engine. The Workflow engine is the process engine.
  For another engine, phase 4 sets the reader of the app over `readStream` and `tail`, with the
  same NDJSON lines, positions, and tail index. Thus eve serves the stream of a session in each
  process of the engine. A Workflow fallback engine that installs later cannot replace it.
- `status` and `tail` take a session ID, because one session can be many runs of an engine.
  `status` can reject with a `SessionStrandedError`. `Runtime.isLive()` uses `status`. A session is
  live when its status is `running`, `parked`, or `paused`. It is not live when `status` rejects
  with a `SessionStrandedError`.
- `Durable` has no `runs`. Authored workflows are a capability that the build reads:
  `BuildContribution.runs`. When an agent has authored workflows and the engine does not set
  `runs`, the build stops with an error.
- `readChildBinding` reads the binding of a remote child session that a workflow tool run kept.
  Only an engine with `runs` gives it.
- `connectionEvents` keeps the owners of connection event bindings. Only the Workflow engine has it
  today. Without it, eve stops a connection event binding with an error.

The `durable` field of the platform gives an engine. Phase 4 starts the engine as `app.durable`.
The engine can add to the build through `DurableEngine.build`:

```ts
interface BuildContribution {
  readonly routes?: readonly EngineRoute[];
  readonly entries?: Readonly<Record<string, string>>; // output file name to module; see "The entry"
  readonly runs?: boolean; // the engine runs authored workflows
}

interface EngineRoute {
  readonly path: string;
  readonly handler: string; // a module: export default (request: Request, app: App) => Response
}
```

The build contribution of the Workflow engine is internal. eve runs its bundle builder and its
generated flow route. `routes` and `entries` are for engines that platforms write. eve does not
build their `routes` yet, so such routes stop the build. `DurableEngine.start()` receives the app
and the result of `context()`.

Each engine decides whether a run stays on the deployment that started it.
`Deployment.deploymentId()` is only a fact about the deployment. An engine can keep runs on their
deployment. Then the platform must keep the workers of each deployment until its runs end, or the
engine must give `ProgramHost.moves`. Vercel Workflow keeps runs on their deployment and gives
`moves`. The other engines in this document continue each run on the current deployment.

Each engine runs the session program. The session program does not import Workflow (#6053), and
guard rule 66 keeps it so. The session battery runs the same session tests on each engine (#6352).
It is the conformance suite of `Durable`.

### The Workflow engine

eve ships one engine:

```ts
function workflowEngine(options?: { world?: string }): DurableEngine; // the module of the World
```

"World" is the name that the Workflow SDK uses for its storage, queue, hooks, and streams. Only the
Workflow engine uses this name. The engine runs each session in a Workflow run, and it adds its step
bundles and its queue route to the build. It makes the World at run time, so a build makes no
World. It sets `build.runs`, and it gives `readChildBinding`, `connectionEvents`,
`ProgramHost.moves`, and `ProgramHost.toolStubs`.

`workflowEngine()` from `eve/experimental/platform` only marks the Workflow engine in the build of
the platform. The compiler applies its `world` to the agent, as `experimental.workflow.world` of
`agent.ts` does. When both name a World and the two names differ, the build stops. The durable
phase then starts the Workflow engine that the build generates. Code that calls the `start()` of
the marked engine receives an error.

The Workflow engine keeps its special work behind the generic operations of `Durable`:

- A prewarm comes to `deliver()` as a session command. The engine prewarms the run, and it puts
  the answer in `prewarm` of the accepted result. A session with no active run is `inactive`.
- A session that the stranded replay guard stops comes back from `deliver()` as `replace`.
  `sessionFor()` with `live` and `status()` reject with a `SessionStrandedError` for such a
  session.
- The check that a client can follow a session is in the stream reader of the engine. It checks
  that the run that holds the inbox of the session can continue, and that its history did not
  expire.
- `Runtime.isLive()` uses `status()`. The Workflow `status()` keeps the old answers: `running`,
  `ended`, or `failed`. It is `running` only when a run that can continue holds the inbox of the
  session.

The `experimental.workflow.world` option of `agent.ts` stays. When the platform has no `durable`
field, eve uses the Workflow engine with the World from that option, or with the local World. The
local World needs a disk.

The Workflow engine modules can use the World directly. These are the binding directories and a
list of named modules, for example the session inbox and the session steps. Guard rule 71
enforces this boundary.

The engine implements `ProgramHost` with the tools of Workflow, as the host does today
(`execution/session/workflow-host.ts`):

- `next()` waits on the inbox from the hooks of the run. With `until`, it races the inbox with one
  `sleep()`, and it keeps that sleep while `until` stays the same. When the sleep ends first,
  `next()` returns `"due"`. A `wake` promise, for example a prewarm, ends the wait with `"woken"`.
- `next()` never returns `"park"`. A run that waits on a hook or a sleep uses no compute. A long
  history goes to a new run through `moves`, for example after a compaction.
- `now()` is `Date.now()`, which the Workflow VM gives again at a replay. `all()` is
  `Promise.allSettled()` over work that the caller started in order.
- `sessionHostClock()` gives `next()`, `now()`, and `all()` to the Workflow engine and to the
  in-process host. Workflow sleeps with `sleep()`, and the in-process host uses its timers.
- Interrupts go to a turn as today. The run reads each delivery while the turn step runs. It
  aborts a signal for a cancel or for a message that steers the turn. The program gives the two
  signals in the `StepCall` of the turn, and Workflow carries them into the step. The step function
  gives them to the turn as `StepMeta.signals`, so the engine does not poll.
- The `sessionWritable` of the turn is the stream of the run.

The dispatcher of `step()` calls the `"use step"` functions of today. It keeps the order of the
correlation IDs of Workflow, so that a run replays on the same eve code. Rules:

- It calls the step function synchronously, with no `await` before the call.
- It never calls a step function as a method, because Workflow serializes `this`.
- `key` is not an argument of the step function. A step that started before a deploy runs on the
  input that Workflow kept.
- It adds no `sleep()`, hook, or attribute call.

The program makes each key as `${sessionId}:${n}:${name}`, where `n` counts the steps of one run.

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
error.

A build can keep a released version string with different eve code, for example a branch build.
Thus the eve build stamps a hash of its session code, and each run keeps it as `$eve.session_code`
beside `$eve.version`. The guard compares both values. It parks a run that another build started,
as it parks a run of another version. It does not continue that run from a record in a new run.
Source that has no stamp, for example the tests of eve and `eve dev` in this repository, stamps no
hash. `runSession()` makes the same check from the record for other engines: see "An engine that
a platform writes".

A checkpoint crosses versions of eve. On Vercel, the successor step of an old deployment starts the
`workflowEntry` of the new deployment with it. A test boots a version 19 checkpoint, which the
previous build wrote, on the new entry.

### An engine that a platform writes

A platform can write its own engine, for example on a database of the platform or on another
workflow product. The engine implements `DurableEngine`. eve gives it two parts: the session
program, and the work of each step.

An engine can register hook routes, and a stream reader for one session, through `hostEngine(app)`
from `eve/experimental/platform`. It has two functions, `route()` and `session()`, and each
registration ends with `app.lifetime`. An engine that registers no reader has its streams served
from its `Durable`.

The session program comes from `eve/experimental/session`. It has no app, uses no Node API, and is
deterministic between steps. `runSession()` runs the program with a `RunSessionHost`. A generator
form of the program is an open question.

```ts
function runSession(run: SessionRun, host: RunSessionHost): Promise<SessionRunResult>;

interface SessionRun {
  readonly sessionId: string;
  readonly start: SessionStartInput;
  readonly record?: SessionRecord; // the last record; none at the first run
}

type SessionRunResult =
  | { readonly kind: "ended"; readonly outcome: "completed" | "failed" | "cancelled" }
  | { readonly kind: "parked"; readonly record: SessionRecord; readonly wakeAt?: number }
  | { readonly kind: "moved" };

interface ProgramHost {
  step<N extends SessionStepName>(
    name: N,
    input: SessionStepInput<N>,
    call: StepCall,
  ): Promise<SessionStepResult<N>>;
  next(options?: {
    until?: number;
    wake?: Promise<unknown>; // background work, for example a prewarm, that ends the wait
  }): Promise<"input" | "due" | "woken" | "park">;
  now(): number;
  all<T extends readonly unknown[]>(
    work: T,
  ): Promise<{ [K in keyof T]: PromiseSettledResult<Awaited<T[K]>> }>;
  readonly moves?: SessionMoves; // only an engine that moves runs to a new deployment
  readonly toolStubs?: ToolStubHost; // stubbed evals
}

interface RunSessionHost extends ProgramHost {
  adopted(record: SessionRecord, consumed: { throughSeq: number }): Promise<void>;
  readonly deploymentId: string;
  readonly inbox: SessionInboxTransport; // the hooks of the session; sessionInbox() makes one
  readonly stream: SessionStreamSink; // the stream of the session
}

type StepCall = Pick<StepMeta, "key" | "signals">; // the turn also receives the signals

function sessionInbox(
  sessionId: string,
  source: SessionInboxSource,
  options: { readonly throughSeq: number }, // the items through this seq are consumed
): SessionInbox; // a SessionInboxTransport, and yielded(): the seq of the last item that it gave

interface SessionInboxSource {
  itemsAfter(seq: number, limit: number): Promise<readonly InboxItem[]>;
  arrival(): Promise<void>; // settles when a new item arrives
  claim(address: DeliveryAddress): Promise<ClaimResult>; // claims a hook address for the session
}

interface InboxItem {
  readonly id: string; // the same at each retry
  readonly seq: number; // the order that the engine kept, from 1
  readonly body:
    | { readonly kind: "deliver"; readonly to: DeliveryAddress; readonly payload: unknown }
    | { readonly kind: "cancel"; readonly reason: string };
}

type SessionRecord = Opaque<"eve.session-record">; // { version, generation, transfer, open, ... }

function sessionCodeHash(): string | undefined; // undefined: source that has no stamp

class SessionCodeMismatchError extends Error {
  readonly sessionId: string;
  readonly recordCode: string | undefined; // the session code that wrote the record
  readonly runningCode: string | undefined; // the session code of this deployment
  static is(error: unknown): error is SessionCodeMismatchError; // also from another copy of eve
}
```

`next()` only looks at the inbox. The inbox stays on the side of the program. The program reads
its items through the inbox transport, and `next()` tells it when to read. An engine makes the
inbox transport with `sessionInbox()` over its own inbox. The source gives the items after a `seq`,
it tells when a new item arrives, and it claims the hook addresses of the session.
`storeDurable()` uses the same function over its store.

Each host has the name of its user. The program uses `ProgramHost`. `runSession()` uses
`RunSessionHost`, which is the only host with `adopted()`. `runSession()` gives `adopted` to the
program, which uses it to keep its records. The Workflow engine and the in-process host keep their
own log. They give the program a `ProgramHost`, so they build no record.

The third argument of `step()` is a `StepCall`: the key, and for the turn, the signals. The turn
takes `sessionWritable` in its input, as the other steps take their data. `runSession()` makes
that writable from `RunSessionHost.stream`, and each write appends at the position after `tail()`.
The Workflow engine puts the signals into the same `turnStep` argument, so the serialized input of
the step keeps its shape.

The work of each step comes from `eve/experimental/platform`. It uses the app, and it can run on
each replica:

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
  load<N extends SessionStepName>( // reads the content of a kept result back for the program
    result: SessionStepResult<N>,
    sessionId: string,
  ): Promise<SessionStepResult<N>>;
}

interface StepMeta {
  readonly key: string;
  readonly sessionId: string;
  readonly attempt: number; // 1 at the first attempt
  readonly deadline?: number; // when the invocation ends; a long turn yields before this time
  readonly signals?: { readonly cancel: AbortSignal; readonly steer: AbortSignal };
}

interface SessionInterrupts {
  poll?(sessionId: string, afterSeq: number): Promise<readonly InboxItem[]>;
}

interface SessionStreamSink {
  tail(sessionId: string): Promise<number>; // the last position, or -1 when the stream is empty
  append(sessionId: string, from: number, lines: readonly string[]): Promise<void>;
  close(sessionId: string): Promise<void>;
}

interface SessionContentStore {
  put(sessionId: string, content: Uint8Array): Promise<string>; // the ID: sha256 of the JSON bytes
  get(sessionId: string, id: string): Promise<Uint8Array>;
  delete(sessionId: string): Promise<void>; // the steps that end a session call it
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
function. Each step of the program goes through `ProgramHost.step()`, with a name in
`SessionStepName`, and guard rule 75 keeps it so. Thus each engine makes all of them durable in one
place.

The record comes from #6455, and #6752 adds it to this stack. It holds `version`, `generation`,
`transfer` (the state that a checkpoint carries), and `open` (the open turn). It can also hold
`timeoutDeadline`, the time when the session times out. When the build has a stamp, it holds
`sessionCode`, the hash of the session code that wrote it. The program writes it only when the open
turn changes or the run parks. It also writes it only when no input that it took is queued or held.
`throughSeq` marks the inbox items that the record consumed. The engine keeps the record, but it
does not read it, so the contents can change. A record has a limit on its size. A list of step
results does not.

A record replays only on the session code that wrote it. Before it changes anything,
`runSession()` compares `sessionCode` with `sessionCodeHash()` of this deployment. When the two
differ, it throws `SessionCodeMismatchError`. The engine then parks the session until a deployment
with that session code runs it, or it retires the session. `storeDurable().run()` makes the same
check, and it leaves the session parked with its record.

Rules for the engine:

- The engine runs one `runSession()` at a time for each session.
- The engine makes each `step` durable with its key. A second call with the same key returns the
  kept result.
- The inbox transport gives the items in the order of `seq`, with no gaps. `next()` returns
  `"input"` when an item waits, `"due"` when the time in `until` comes, and `"woken"` when `wake`
  settles. It returns `"park"` when the engine wants to end the run. Examples are a session with no
  work, and a limit of the history or of the invocation.
- When the program calls `adopted()`, the engine keeps the record and `throughSeq` before the call
  returns.
- To continue a session, the engine calls `runSession()` with the last record. Then the inbox
  transport gives the items after `throughSeq` again. Examples are after a crash, after
  `"parked"`, and at a due time.
- `now()` and `all()` are durable. A replay receives the same values.
- When a turn step yields, the engine runs it again with the same key and the next attempt. The
  program never sees `{ yielded: true }`.
- `deliver()` also makes the item available to `SessionInterrupts.poll()`. Thus a turn that runs
  can read a cancel, or a message that steers the turn. An engine that pushes the two signals into
  a step that runs gives `StepMeta.signals` instead.
- The stream sink never replaces a line. `append()` writes at `from` only when `from` is the next
  position. Else it throws, and the step runs again. Thus positions only increase, and a reader
  never sees a line change.
- The engine passes the session battery. The battery tests a second `start`, a second `deliver`
  with the same key, and an interrupt in a turn that runs. The Workflow engine and the in-process
  host ignore the key of a delivery. Thus the case of a held key runs only on hosts that use keys.
  The third host of the battery, `store`, runs `storeDurable()`. It runs 16 cases, and it skips 8
  cases that need Workflow. One of the 16 cases ends a parked session at its session timeout.

Rules for eve:

- The program reads no clock and makes no race outside `ProgramHost`. It uses `now()`, `all()`,
  and `next({ until })`. Part 2 of guard rule 75 enforces this: the files of the program use no
  `Date.now`, `new Date()` without an argument, `Promise.race`, `all`, `allSettled`, or `any`. They
  also use no `setTimeout`, `setInterval`, or `Math.random`.
- The input and the result of each step are plain data, with one exception. The input of the turn
  has `sessionWritable`, which is a stream and not data. Thus this rule is not true for streams
  yet. An engine cannot send a stream to another process. But `sessionSteps()` gives the turn a
  writable on its stream sink. Thus such an engine can remove `sessionWritable` before it sends
  the input. A turn step returns the full history and
  session state (`DurableStepResult` in `turn-step-types.ts`), so a result can be larger than
  `SESSION_LIMITS`. With a `content` store, a step puts each large value of its `stateDelta` in the
  store, and its result has the ID. A retried step puts the same content and receives the same ID.
  `SessionSteps.load()` reads the content back for the program. Without a store, the content stays
  in the result, as on Workflow. The engine gives this store, not `Storage`, because the content
  lives as long as the session. The steps that end a session delete it.
- A turn step stops or steers the turn from `StepMeta.signals`, or else from `interrupts`. It
  applies the rules of `active-turn.ts` to each item: a cancel of this turn, or a message that
  steers it. The polled interrupts start at the head of the inbox at the first poll of the turn.
- A retried step reads the lines of the earlier attempt from its start position. It appends lines
  that close the open records of that attempt as interrupted, as `readOrphanedLines()` and
  `supersede()` do today. `StepMeta.attempt` tells the step that it is a retry.
- A turn step yields before `deadline`.
- `runSession()` reads the records of the previous minor version of eve. It stops a newer record
  with a `SessionRecordTooNew` error.
- The session program imports no Node API, does no I/O, and reads no global. #6752 removes
  most Node APIs from the session core. Guard rule 74 follows the value imports of the session
  program and stops at a Node-only import. Its baseline is zero since #6758. Guard rule 73 does
  the same for the web versions in `src/runtime-env/`.
- The program imports no `"use step"` function. Each step goes through `ProgramHost.step()`. Part 1
  of guard rule 75 follows the value imports of the modules of rule 66. It also follows those of
  the finalization, admission, and task modules of the program.

### Engines that keep sessions in a store

Many products give durable steps and a wake, but no ordered inbox, no stream, and no address map.
For these engines, eve has a store interface. The platform gives a store, and the engine gives only
a wake:

```ts
interface SessionStore {
  begin(start: SessionStartInput & { sessionId: string }): Promise<void>;
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
  };
  readonly content: SessionContentStore;
}

type ClaimResult =
  | { readonly claimed: true }
  | { readonly claimed: false; readonly heldBy: string };

function storeDurable(options: {
  store: SessionStore;
  wake(sessionId: string, options?: { at?: number }): Promise<void>; // without at: run it now
}): {
  durable: Durable;
  interrupts: SessionInterrupts;
  streams: SessionStreamSink;
  content: SessionContentStore;
  run(sessionId: string, host: StoreRunHost): Promise<SessionRunResult>;
};

type StoreRunHost = Pick<RunSessionHost, "step" | "deploymentId" | "toolStubs">;
```

`storeDurable()` makes `Durable`, the interrupts, the stream sink, and the content store from the
store. `deliver()` adds the item to the store, with one item for each key, and then it calls
`wake()`. The engine starts or wakes the run of the session. `run()` takes a `StoreRunHost`, which
has only the parts of `RunSessionHost` that the engine gives: the durable steps, the deployment
ID, and the tool stubs. `run()` makes the inbox transport with `sessionInbox()` over the store,
and it gives the stream sink of the store as `stream`. It continues the session from its last
record, and it parks the session when it has no work. eve serves the streams of such an engine
through `Durable.readStream()` and `tail()`, which read the store. A store for one database is in
its own package. Thus eve adds no runtime dependency.

A session on `storeDurable()` has a session timeout. The program keeps the deadline in the record
as `timeoutDeadline`. When a parked result has a `wakeAt`, `run()` calls `wake(sessionId, { at })`,
and the engine runs the session again at that time. Examples are the end of an idle sandbox window
and the session timeout. The default session timeout is 30 days. One Node `setTimeout()` cannot
wait that long, so an engine keeps a far wake in its store or in a scheduler.

This table shows how each engine that this design examined fits the interface:

| Engine                     | The program runs in                    | Inbox and wake                        | Park and continue                    |
| -------------------------- | -------------------------------------- | ------------------------------------- | ------------------------------------ |
| Workflow                   | A `"use workflow"` body                | Hooks                                 | `sleep()`, and `moves`               |
| Temporal                   | The workflow sandbox                   | A store, and a signal as the wake     | `continueAsNew()`                    |
| Durable Task, Dapr         | A generator, which is an open question | External events                       | `continueAsNew()`                    |
| Restate                    | A virtual object handler               | A store, and an awakeable as the wake | A new invocation at the next wake    |
| Resonate                   | An async function                      | A store                               | A detached call                      |
| Inngest                    | A function, run again from the top     | A store, and an event as the wake     | A new run at each wake               |
| Trigger.dev                | A task process                         | A store, or session input             | A new run on the latest version      |
| DBOS, Hatchet              | A workflow or a durable task           | A store                               | A short run at each wake             |
| Lambda durable functions   | A durable handler                      | A store, and a callback               | A new execution for each generation  |
| Step Functions             | A task that the state machine starts   | A task token                          | An execution at each wake            |
| Cloudflare Workflows       | A workflow instance                    | A Durable Object, and `sendEvent()`   | A new instance before the step limit |
| Cloudflare Durable Objects | An alarm                               | SQLite                                | An alarm                             |

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
  gives a step only serialized input. The step bodies read it.
- **The hosts of the process.** `app.hosts` holds its hook routes and session streams. Code that
  has no app reads `builtInHosts()`, which also holds the process engine. Examples are the
  callback route, the bare Workflow runtime, and the A2A projection. Others are the invocation
  streams, the remote credentials, the end of a stranded session, and the public
  `sessions.attach`.
- **The selected declaration of the process.** The seam module records it in `platform/process.ts`
  (`eve.process-platform`), with a lifetime for its factories. Code that has no app makes its
  entities from it, one time for each process. Examples are the Workflow fallback engine and
  `DefaultSandbox` outside a turn.
- **The build compute.** The build records `Build.prewarm.compute` for the scope of a build
  (`eve.build-compute`), so prewarm and the sandbox environments of the compiler use it.
- **The World of the Workflow SDK.** The SDK reads it internally. Only the Workflow engine uses it.
- **Workflow configuration in environment variables.** The queue namespace, the deployment ID, and
  the spec version are SDK inputs. The Workflow engine writes them before it makes the World.
- **The global tracer provider of OpenTelemetry.**
- **Brand symbols.** They mark the type of an object. They hold no state.

## Example: a self-hosted Node server with the Postgres World

An operator runs the agent as a container image on Kubernetes, with three replicas and one
PostgreSQL database. The agent uses the Workflow engine on the Postgres World, and PostgreSQL for
memory documents. The model is a model object, so model calls go directly to the provider.

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
import { definePlatform, registerCleanup, workflowEngine } from "eve/experimental/platform";
import pg from "pg";

import { postgresDocuments } from "./lib/postgres-documents";

const host = "support-agent.acme.internal";

export default definePlatform({
  deployment: () => ({
    environment: () => "production",
    deploymentId: () => process.env.IMAGE_TAG,
    publicHost: () => host,
    productionHost: () => host,
    scope: () => ({
      platform: "acme-kubernetes",
      id: "support-agent",
      environment: "production",
      variant: null,
    }),
  }),

  // The World reads WORKFLOW_POSTGRES_URL, or else DATABASE_URL, at run time.
  durable: () => workflowEngine({ world: "@workflow/world-postgres" }),

  storage: (app) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 10 });
    registerCleanup(app.lifetime, () => pool.end());
    return { documents: postgresDocuments(pool) };
  },
});
```

```ts title="agent/lib/postgres-documents.ts"
import { MemoryDocumentConflictError, type MemoryDocumentBackend } from "eve/memory/file";
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

The platform reads `IMAGE_TAG` and `DATABASE_URL` in its factories, and the World reads its own
connection variables. eve reads none of them. The platform module decides where its settings come
from.

The Postgres World does not keep runs on their deployment. After a rollout, the new replicas
continue the runs that the old replicas started, when the version of eve does not change.

### Boot and calls

1. `eve build` finds `agent/platform.ts` and reads the declaration. The platform has no `build`
   field, so the output is a Node server. The compiler applies the World of `workflowEngine()` to
   the agent, and the Workflow engine adds its step bundles. The build calls no runtime factory, so
   it does not connect to PostgreSQL.
2. A Kubernetes job runs `bootstrap` from `@workflow/world-postgres` before each rollout. This
   command makes the World schema.
3. `eve start` starts in each replica. The Node server of eve calls `start()`. Phase 4 starts
   the engine as `app.durable`.
4. The Workflow engine records the app for the process, and it registers the direct queue
   handler. Graphile Worker gives each job to one replica, and the step runs in that replica.
5. An HTTP request reaches a route, which has the app from `#eve/route-app`. A memory write uses
   the `storage` entity, which uses the pool that its factory opened.
6. At shutdown, the server calls `endLifetime(app.lifetime)`. It closes the pool and the World in
   the opposite order of registration.

### What the operator has

| Entity     | Result                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `Durable`  | The Workflow engine on the Postgres World. Each replica processes jobs.                        |
| `Storage`  | PostgreSQL, with optimistic writes.                                                            |
| `Compute`  | Not set, so `DefaultSandbox` uses Docker when it exists.                                       |
| `Triggers` | Not set. Authored schedules run in each server. `defineDynamicSchedules()` needs a `provider`. |
| `Identity` | Not set. OIDC route auth checks the token and the claim matchers.                              |
| `Network`  | Not set. Callbacks have no extra headers. A workspace agent needs its own `transport`.         |

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

| Rule for an engine                           | Durable Object                                                             |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| One run at a time for each session           | One instance for each session ID. Calls run one at a time.                 |
| Make each step durable with its key          | Write the result of the step to SQLite, with its key, before it returns.   |
| Give the items in order                      | A SQLite table with `seq` as the primary key                               |
| `"park"` when there is no work               | `next()` returns `"park"` when the inbox is empty.                         |
| Keep the record and `throughSeq`             | Write them to SQLite before `adopted()` returns.                           |
| Continue from the last record                | Read the record from SQLite. The inbox gives the items after `throughSeq`. |
| Interrupts                                   | `poll()` reads the inbox table while a turn runs.                          |
| The stream sink writes only the next line    | The line position is the primary key, so a second write fails.             |
| Large content leaves the step result         | A SQLite table, with the hash of the content as the key                    |
| A delivery or a due time starts the next run | `ctx.storage.setAlarm()`                                                   |

### The files

```text
agent/
  agent.ts
  platform.ts
  lib/engine.ts           # Durable: RPC to the EveSession objects
  lib/session-store.ts    # The inbox, record, steps, streams, and RunSessionHost of one session, on SQLite
  lib/access.ts           # Identity: accepts the callers of Cloudflare Access tokens
  lib/alarm-schedules.ts  # Triggers: the dynamic and the authored schedules on EveSchedule objects
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
import { definePlatform } from "eve/experimental/platform";

import { verifyAccessToken } from "./lib/access";
import { alarmSchedules, registerAuthored } from "./lib/alarm-schedules";
import { durableObjectEngine } from "./lib/engine";
import { r2Documents } from "./lib/r2-documents";
import { cloudflareSandbox } from "./lib/sandbox-client";

const host = "support-agent.acme.workers.dev";

export default definePlatform({
  context: async () => (await import("cloudflare:workers")).env as Env,

  deployment: (app, env) => ({
    environment: () => "production",
    deploymentId: () => env.CF_VERSION_METADATA.id,
    publicHost: () => host,
    productionHost: () => host,
    scope: () => ({
      platform: "cloudflare",
      id: "support-agent",
      environment: "production",
      variant: null,
    }),
  }),

  durable: () => durableObjectEngine(),
  triggers: (app, env) => ({
    schedules: alarmSchedules(env.EVE_SCHEDULES),
    register: (schedules) => registerAuthored(env.EVE_SCHEDULES, schedules),
  }),
  compute: (app, env) => cloudflareSandbox(env.EVE_SANDBOX),
  storage: (app, env) => ({ documents: r2Documents(env.EVE_MEMORY) }),
  identity: () => ({ verifyOidcCaller: (caller) => verifyAccessToken(caller, "acme") }),
  network: (app, env) => ({
    peer: (name) => env[name],
    fetchUntrusted: (request) => fetch(request),
  }),
  build: {
    entry: "./lib/worker.ts",
    conditions: ["workerd", "worker", "browser"],
    schedules: { authored: true },
  },
});
```

`agent/platform.ts` imports no Cloudflare module at the top level. The build entry point is Node,
and Node does not have `cloudflare:workers`. `context()` loads the bindings at run time, and each
factory receives them as `env`. Only `worker.ts` imports `cloudflare:workers` at the top level, and
only the Worker loads `worker.ts`.

The guard of eve needs a `fetch` that uses its dispatcher. The global `fetch` of a Worker does not
use it, so the guard refuses each request. Thus the platform gives `fetchUntrusted`, and eve uses it
for each untrusted URL. The global `fetch` of a Worker cannot connect to private addresses, so it
is a guard for this platform.

```ts title="agent/lib/engine.ts"
import {
  registerCleanup,
  type App,
  type DeliveryAddress,
  type Durable,
  type DurableEngine,
} from "eve/experimental/platform";

import { addressKey } from "./session-store";

let engineApp: App | undefined;

// The app of this isolate, with the Durable of the engine. worker.ts gives it to sessionSteps().
export function startedEngineApp(): App {
  if (engineApp === undefined) throw new Error("The app of this isolate did not start.");
  return engineApp;
}

export function durableObjectEngine(): DurableEngine<Env> {
  return {
    start(app, env) {
      const { EVE_SESSIONS: sessions, EVE_ADDRESSES: addresses } = env;
      const session = (sessionId: string) => sessions.getByName(sessionId);
      const sessionFor = (to: DeliveryAddress) => addresses.getByName(addressKey(to)).find();
      const durable: Durable = {
        async start(input) {
          const sessionId = input.sessionId ?? crypto.randomUUID();
          await session(sessionId).start({ ...input, sessionId });
          return { kind: "started", sessionId };
        },
        async deliver(to, payload, options) {
          const sessionId = await sessionFor(to);
          if (sessionId === undefined) {
            const cause = new Error(`No session holds "${addressKey(to)}".`);
            return { accepted: false, reason: "inactive", cause };
          }
          await session(sessionId).deliver(to, payload, options?.key);
          return { accepted: true, sessionId };
        },
        sessionFor,
        readStream: (sessionId, from) => session(sessionId).readStream(from),
        tail: (sessionId) => session(sessionId).tail(),
        status: (sessionId) => session(sessionId).status(),
      };
      engineApp = { ...app, durable };
      registerCleanup(app.lifetime, () => {
        engineApp = undefined;
      });
      return durable;
    },
  };
}
```

The engine reads the bindings in `start()`. Thus the build reads `durable` in Node without the
bindings. The engine makes a session ID when the caller gives none. It sets no `build.runs` and
gives no `moves`. A cancel comes through `deliver()`.

In an entry build, `start()` from `eve:app` returns only `fetch`. Thus the engine keeps its own
`App`: the app of its `start()` with the `Durable` that it returns. `worker.ts` gives that app to
`sessionSteps()` and to the schedule functions. The engine registers no stream reader. eve reads
each stream through `Durable.readStream()` and `tail()`, which call `EveSession` through RPC.

```ts title="agent/lib/worker.ts"
import "eve:instrumentation";
import { start } from "eve:app";
import { DurableObject } from "cloudflare:workers";
import {
  deliverScheduleOccurrence,
  runAuthoredSchedule,
  sessionSteps,
  type AuthoredSchedule,
  type DeliveryAddress,
  type SessionStartInput,
} from "eve/experimental/platform";
import type { ScheduleRecord } from "eve/experimental/schedules";
import {
  runSession,
  SessionCodeMismatchError,
  type SessionRunResult,
} from "eve/experimental/session";

import { nextOccurrence } from "./alarm-schedules";
import { startedEngineApp } from "./engine";
import { sqliteSession } from "./session-store";

let started: ReturnType<typeof start> | undefined;
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
    await app(); // starts the app of this isolate, and with it the engine
    const steps = sessionSteps(startedEngineApp(), { streams, interrupts, content });
    let result: SessionRunResult;
    try {
      result = await runSession(session.run(), session.host(steps));
    } catch (error) {
      if (!SessionCodeMismatchError.is(error)) throw error;
      result = { kind: "ended", outcome: "cancelled" }; // retire: no isolate runs that code now
    }
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

type StoredSchedule =
  | { readonly kind: "dynamic"; readonly record: ScheduleRecord; readonly payload: unknown }
  | { readonly kind: "authored"; readonly schedule: AuthoredSchedule };

export class EveSchedule extends DurableObject<Env> {
  async put(stored: StoredSchedule): Promise<void> {
    await this.ctx.storage.put("schedule", stored);
    await this.ctx.storage.setAlarm(nextOccurrence(expressionOf(stored), Date.now()));
  }

  async alarm(): Promise<void> {
    const stored = await this.ctx.storage.get<StoredSchedule>("schedule");
    if (stored === undefined) return;
    await app(); // starts the app of this isolate, and with it the engine
    if (stored.kind === "authored") {
      await runAuthoredSchedule(startedEngineApp(), stored.schedule.name);
    } else {
      const { record, payload } = stored;
      const scheduledAt = new Date().toISOString();
      await deliverScheduleOccurrence(startedEngineApp(), {
        payload,
        occurrence: {
          executionId: `${record.scheduleId}:${scheduledAt}`,
          name: record.name,
          scheduleId: record.scheduleId,
          scheduledAt,
        },
      });
    }
    await this.ctx.storage.setAlarm(nextOccurrence(expressionOf(stored), Date.now()));
  }
}

function expressionOf(stored: StoredSchedule) {
  if (stored.kind === "dynamic") return stored.record.expression;
  const { cron, timezone } = stored.schedule;
  return { type: "cron" as const, cron, ...(timezone !== undefined && { timezone }) };
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
Object. `run()` gives the session ID, the start input, and the last record. `host(steps)` gives the
`RunSessionHost`. Its `step()` keeps each result in SQLite with the key from its `StepCall`. Thus
an alarm that runs again does not do a step two times. It runs a yielded turn again with the same
key and the next attempt. Its `inbox` is `sessionInbox()` over the inbox table. `itemsAfter()`
reads the table in the order of `seq`, `arrival()` settles at the next delivery, and `claim()`
claims an address in an `EveAddress` object. Its `next()` returns `"input"` when an item waits.
When the inbox is empty, `next()` returns `"park"`, or `"due"` when the time in `until` is past.
Thus a run ends when the session has no work, and a delivery or the alarm starts the next run.
`next()` also returns `"park"` near the time limit of an alarm. `adopted()` writes the record and
`throughSeq`. `stream` and `streams` are one `SessionStreamSink` on the stream table, with the
position as the primary key. `streams` also reads the lines. `interrupts` reads the inbox while a
turn runs. `content` keeps large content in SQLite. `finish()` keeps the status. `begin()` claims
the addresses of the session in `EveAddress` objects, and `addressKey()` makes the key of an
address.

`alarm()` retires a session whose record has another session code. This platform keeps no Worker
version for old records, so it does not park such a session.

`alarmSchedules()` is a `ScheduleProvider`. Its `create()` keeps each schedule and the payload in
the `EveSchedule` object of its name. The alarm of that object comes due at each occurrence.
The platform sets `build.schedules.authored`. Thus the build adds no scheduled tasks, and at boot
`registerAuthored()` keeps each authored schedule in an `EveSchedule` object too. It is
idempotent, because each isolate calls it. When an alarm comes due, `EveSchedule` starts the app
of its isolate. It calls `deliverScheduleOccurrence()` for a dynamic schedule, or
`runAuthoredSchedule()` for an authored schedule. `r2Documents()` and `cloudflareSandbox()` follow
the same pattern on R2 and on `EveSandbox`.

This table shows where each part fits into the design:

| Code                                       | Part of the design                                                            | Caller                               |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------ |
| The default export of `worker.ts`          | The entry (`Build.entry`): it starts the app and serves `app.fetch()`         | Cloudflare, for each request         |
| `durableObjectEngine()` in `platform.ts`   | The `durable` field: a `DurableEngine` that the platform writes               | Phase 4 of the lifecycle             |
| `EveSession` RPC methods and `EveAddress`  | The storage behind `Durable`                                                  | `durableObjectEngine()`, through RPC |
| `sqliteSession().run()` and `host(steps)`  | The start input, the record, and the `RunSessionHost` of one session          | `runSession()`                       |
| `EveSession.alarm()`                       | Engine code: `sessionSteps()` with the app of the engine, then `runSession()` | Cloudflare, when the alarm comes due |
| `alarmSchedules()` and `EveSchedule.put()` | The `triggers` field: the `Triggers` entity                                   | The schedules client                 |
| `registerAuthored()`                       | `Triggers.register()`: the authored schedules                                 | The `triggers` phase of each isolate |
| `EveSchedule.alarm()`                      | Trigger code: `deliverScheduleOccurrence()` or `runAuthoredSchedule()`        | Cloudflare, when the alarm comes due |
| `cloudflareSandbox()` and `EveSandbox`     | The `compute` field: the `Compute` entity                                     | The code that opens a sandbox        |
| `r2Documents()`                            | The `storage` field: the `Storage` entity                                     | The memory file store                |
| `verifyAccessToken()`                      | The `identity` field: the `Identity` entity                                   | OIDC route auth                      |
| The service binding lookup                 | The `network` field: `Network.peer`                                           | Calls to workspace agents            |
| The global `fetch`                         | The `network` field: `Network.fetchUntrusted`                                 | `web_fetch` and session callbacks    |

### Boot and calls

1. `eve build` reads the declaration. It builds the app, and it bundles `worker.ts` around it.
2. `wrangler deploy` uploads the Worker, the Durable Object classes, and the sandbox image.
3. A user sends a message. The `fetch` handler of `worker.ts` starts the app at the first request
   of the isolate, and it gives each request to `app.fetch()`. The route calls the session
   runtime, which calls `Durable.deliver()`. The engine finds the session through
   its address, and it calls `EveSession.deliver()` through RPC.
4. `EveSession.deliver()` keeps the delivery in SQLite and sets the alarm. `EveSession.alarm()`
   starts the app of its isolate. It makes the steps with `sessionSteps()` and the app of the
   engine, and it calls `runSession()`.
5. The session program runs. Each step keeps its result in SQLite, and `adopted()` keeps the
   record. When the inbox is empty, `next()` returns `"park"`. The program returns `"parked"`,
   and `alarm()` sets the next wake time.
6. A client reads the stream route in any isolate. eve reads the stream through
   `Durable.readStream()`, which calls `EveSession` through RPC. The NDJSON lines, positions, and
   leases are the same as on Vercel.
7. A schedule comes due. `EveSchedule.alarm()` runs it through `deliverScheduleOccurrence()` or
   `runAuthoredSchedule()`.

An alarm that throws runs again later. The next run continues from the last record.

### Limits

This example uses only the experimental API, and its platform code is in its own package. The
engine of this example is not in this repository, by design. These limits stay:

- An entry build needs `AsyncLocalStorage` as a global. If Workers do not set it, the entry of the
  platform sets it: `worker.ts` first imports a module that sets the global.
- An agent with authored workflows needs an engine with `runs`. This engine sets no `runs`, so such
  an agent does not build for this platform. See [Open questions](#open-questions).
- Workers have no processes and no local Docker. Thus the Docker and `just-bash` sandboxes and the
  development file store do not work, and the platform gives `compute` and `storage`.
- `Compute.credentialTransforms` is `false` until an adapter uses the outbound interception of
  Containers.
- Model credentials come from `models` or from an AI Gateway API key.

## Example: Temporal as the durable engine

An operator runs the agent as a container image on Kubernetes, as in the Postgres example. A
Temporal cluster is the durable engine, without Workflow. The platform writes the engine. The other
entities are the same as in the Postgres example.

### How Temporal runs sessions

The session program runs in a Temporal workflow, and each step runs as a Temporal activity. A
`SessionStore` on PostgreSQL keeps the inbox, the stream, and the addresses. A signal wakes the
workflow. Each rule for an engine has an equivalent:

| Rule for an engine                   | Temporal                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| One run at a time for each session   | One workflow execution for each session. The workflow ID is the session ID.                                 |
| Make each step durable with its key  | Each step is an activity. Temporal keeps its result in the history.                                         |
| Give the items in order, and `"due"` | An activity reads the items after `seq`. `condition()` waits for the wake signal or the time.               |
| `"park"` with no work or at a limit  | `next()` returns `"park"` when the inbox is empty, or when `continueAsNewSuggested` is true.                |
| Keep the record and `throughSeq`     | The workflow keeps them in variables. Temporal replays the history to make them again.                      |
| Continue from the last record        | After an idle park, the workflow waits for a wake or `wakeAt`. Then it calls `continueAsNew()`.             |
| `now()` and `all()` are durable      | `Date.now()` and `Promise.allSettled()` are deterministic in the sandbox.                                   |
| Interrupts and the stream            | `storeDurable()` gives both from the store.                                                                 |
| A turn yields before its deadline    | The deadline is the end of the activity time limit. The workflow runs the turn again with the next attempt. |

A history has limits: 51,200 events, 50 MB, and 10,000 signals. A payload has a limit of 2 MB.
Thus the workflow continues as new before its history is at a limit. The step results stay in the
history, because the program in the sandbox cannot call `SessionSteps.load()`. Thus the steps
receive no content store.

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
import { definePlatform } from "eve/experimental/platform";

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
  type DeliveryAddress,
  type DurableEngine,
  type SessionSteps,
  type SessionStore,
} from "eve/experimental/platform";
import type { SessionRecord, SessionStepName } from "eve/experimental/session";

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

      const { durable, interrupts, streams } = storeDurable({
        store,
        // The workflow keeps wakeAt itself, so this wake never receives `at`.
        wake: async (sessionId) => {
          await client.workflow.signalWithStart(sessionWorkflow, {
            workflowId: sessionId,
            taskQueue: options.taskQueue,
            args: [sessionId],
            signal: wakeSignal,
          });
        },
      });
      const steps = sessionSteps({ ...app, durable }, { streams, interrupts });

      const workerConnection = await NativeConnection.connect({ address: options.address });
      registerCleanup(app.lifetime, () => workerConnection.close());
      const worker = await Worker.create({
        connection: workerConnection,
        namespace: options.namespace,
        taskQueue: options.taskQueue,
        workflowsPath: fileURLToPath(new URL("./session-workflow.ts", import.meta.url)),
        activities: engineActivities(store, steps, app.platform.deployment.deploymentId() ?? ""),
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

function engineActivities(store: SessionStore, steps: SessionSteps, deploymentId: string) {
  return {
    step: (
      name: SessionStepName,
      input: unknown,
      key: string,
      sessionId: string,
      tries: number,
    ) => {
      const { attempt, startToCloseTimeoutMs } = Context.current().info;
      const deadline = Date.now() + startToCloseTimeoutMs - 30_000;
      return steps.run(name, input, { key, sessionId, attempt: tries + attempt, deadline });
    },
    loadRun: async (sessionId: string) => ({ ...(await store.loadRun(sessionId))!, deploymentId }),
    itemsAfter: (sessionId: string, seq: number, limit: number) =>
      store.itemsAfter(sessionId, seq, limit),
    claim: (sessionId: string, addresses: readonly DeliveryAddress[], takeOver: boolean) =>
      store.claim(sessionId, addresses, takeOver),
    saveRecord: (sessionId: string, record: SessionRecord, throughSeq: number) =>
      store.saveRecord(sessionId, record, throughSeq),
    tail: (sessionId: string) => store.streams.tail(sessionId),
    append: (sessionId: string, from: number, lines: readonly string[]) =>
      store.streams.append(sessionId, from, lines),
    close: (sessionId: string) => store.streams.close(sessionId),
  };
}

export type EngineActivities = ReturnType<typeof engineActivities>;
```

```ts title="agent/lib/session-workflow.ts"
// This module runs in the workflow sandbox of Temporal: no Node API, no I/O, and no app.
import * as wf from "@temporalio/workflow";
import {
  runSession,
  sessionInbox,
  type RunSessionHost,
  type SessionRecord,
} from "eve/experimental/session";

import type { EngineActivities } from "./temporal-engine";

const act = wf.proxyActivities<EngineActivities>({ startToCloseTimeout: "15 minutes" });

export const wakeSignal = wf.defineSignal("eve.wake");

export async function sessionWorkflow(
  sessionId: string,
  carried?: { record: SessionRecord; throughSeq: number },
): Promise<void> {
  let wakes = 0;
  wf.setHandler(wakeSignal, () => void wakes++);
  const wokenSince = (seen: number) => () => wakes !== seen;

  const loaded = await act.loadRun(sessionId);
  const record = carried?.record ?? loaded.record;
  let throughSeq = carried?.throughSeq ?? loaded.throughSeq;
  let read = 0; // the wake counter at the last read of the inbox
  let idle: number | undefined; // the wake counter when next() found no work
  const inbox = sessionInbox(
    sessionId,
    {
      itemsAfter: (seq, limit) => {
        read = wakes;
        return act.itemsAfter(sessionId, seq, limit);
      },
      arrival: () => wf.condition(wokenSince(read)),
      claim: (address) => act.claim(sessionId, [address], false),
    },
    { throughSeq },
  );

  const host: RunSessionHost = {
    step: async (name, input, { key }) => {
      const data = withoutStream(input); // the turn receives a writable from sessionSteps()
      for (let tries = 0; ; tries++) {
        const result = await act.step(name, data, key, sessionId, tries);
        if (!("yielded" in result)) return result;
      }
    },
    next: async ({ until, wake } = {}) => {
      let woken = false;
      void wake?.then(() => (woken = true));
      idle = undefined;
      for (;;) {
        if (wf.workflowInfo().continueAsNewSuggested) return "park";
        const seen = wakes;
        if ((await act.itemsAfter(sessionId, inbox.yielded(), 1)).length > 0) return "input";
        if (woken) return "woken";
        if (until === undefined && wake === undefined) {
          idle = seen;
          return "park"; // no work: the run ends, and a wake or wakeAt starts the next one
        }
        const ready = () => wakes !== seen || woken;
        if (until === undefined) await wf.condition(ready);
        else if (!(await wf.condition(ready, Math.max(0, until - Date.now())))) return "due";
      }
    },
    now: () => Date.now(),
    all: (work) => Promise.allSettled(work),
    adopted: async (next, consumed) => {
      throughSeq = consumed.throughSeq;
      await act.saveRecord(sessionId, next, consumed.throughSeq);
    },
    deploymentId: loaded.deploymentId,
    inbox,
    stream: { tail: act.tail, append: act.append, close: act.close },
  };

  const result = await runSession({ sessionId, start: loaded.start, record }, host);
  if (result.kind === "parked") {
    if (idle !== undefined) {
      const woken = wokenSince(idle);
      if (result.wakeAt === undefined) await wf.condition(woken);
      else await wf.condition(woken, Math.max(0, result.wakeAt - Date.now()));
    }
    await wf.condition(wf.allHandlersFinished);
    await wf.continueAsNew<typeof sessionWorkflow>(sessionId, {
      record: result.record,
      throughSeq,
    });
  }
}

function withoutStream(input: unknown): unknown {
  if (typeof input !== "object" || input === null || !("sessionWritable" in input)) return input;
  const { sessionWritable: _, ...data } = input;
  return data;
}
```

`postgresStore()` is a `SessionStore` on PostgreSQL. The stream lines have the session ID and the
position of the line as the primary key. The inbox has the session ID and `seq` as the primary key,
and a unique item ID. A store of this type can be in its own package, and many engines can use it.
The engine registers no stream reader. eve reads each stream through `Durable.readStream()` and
`tail()`, which read the store, in each replica.

The inbox of the host is `sessionInbox()` over the `itemsAfter` and `claim` activities.
`arrival()` waits for the next wake signal. Its `yielded()` gives the `seq` of the last item that it
gave. The `stream` of the host is the stream sink of the store, through the `tail`, `append`, and
`close` activities. `storeDurable().run()` reads the store directly. Thus it cannot run in the
sandbox, and the workflow gives its own `RunSessionHost`.

The workflow does not call `storeDurable().run()`, so it keeps `wakeAt` itself. When `next()` finds
no work, the program parks with its record and `wakeAt`. The workflow then waits for a wake signal,
or until `wakeAt`. Thus a session timeout ends an idle session.

The `step()` of the host sends the input of each step to an activity. A stream cannot go to an
activity, so `withoutStream()` removes `sessionWritable` from the input of the turn. In the
activity, `sessionSteps()` gives the turn a writable on the stream sink of the store.

`saveRecord` also keeps the record in the store. Thus a new workflow, for example after the
operator ends one, can load the session again from the store. The worker bundles
`session-workflow.ts` with webpack when it starts. Thus the image must have that module as a file.

`next()` reads the wake counter before it reads the inbox. Thus a wake that comes while it reads
lets the wait end immediately, and no item stays unread. The activities send no heartbeats, so
the proxy sets no `heartbeatTimeout`. `startToCloseTimeout` limits each attempt, and a turn yields
before that time. The cleanups run in the opposite order of registration. Thus the worker stops
first, then its connection closes, and then the connection of the client closes.

This table shows where each part fits into the design:

| Code                                | Part of the design                                                           | Caller                            |
| ----------------------------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| `temporalEngine()` in `platform.ts` | The `durable` field: a `DurableEngine` that the platform writes              | Phase 4 of the lifecycle          |
| `storeDurable()` in `start()`       | `Durable`, the interrupts, and the stream sink, from the store               | The session runtime of eve        |
| The `wake` function                 | `signalWithStart()`: it starts the workflow, or it wakes it                  | `Durable.start()` and `deliver()` |
| `postgresStore()`                   | The `SessionStore`                                                           | `storeDurable()` and activities   |
| The worker in `start()`             | Engine code: it runs `sessionSteps()` with the app as activities             | Temporal, for each activity       |
| `sessionWorkflow()`                 | Engine code: `runSession()` in the workflow sandbox, with a `RunSessionHost` | Temporal, for each workflow       |
| `registerCleanup()` in `start()`    | The worker and the connection end with the lifetime of the app               | `endLifetime()` at shutdown       |

### Boot and calls

1. `eve build` reads the declaration. It builds the Node server. The engine opens nothing at build.
2. A replica starts. Phase 4 calls `temporalEngine().start(app)`. The engine connects to Temporal,
   and it starts a worker on the task queue.
3. A user sends a message. The route calls the session runtime, which calls `Durable.deliver()`.
   The store finds the session through its address and adds the item. Then `wake` sends the signal.
4. `sessionWorkflow()` wakes. `next()` reads the item from the store, and the program calls the
   `turn` step. Temporal runs the step as an activity on a replica. The step writes its stream lines
   to the store, and it reads the interrupts from the store.
5. When the open turn changes, the program calls `adopted()`. The workflow keeps the record and
   `throughSeq`.
6. When the inbox is empty, `next()` returns `"park"`. The program returns `"parked"` with the
   record and `wakeAt`. The workflow waits for a wake signal or for `wakeAt`. Then it continues as
   new with the record and `throughSeq`. When the history is long, it continues as new immediately.
7. A client reads the stream route on any replica. eve reads the stream through
   `Durable.readStream()`, which reads from the store. The NDJSON lines, positions, and leases are
   the same as on Vercel.

### Limits

This example uses only the experimental API, and its platform code is in its own package. The
engine of this example is not in this repository, by design. These limits stay:

- An agent with authored workflows needs an engine with `runs`. This engine sets no `runs`, so such
  an agent does not build for this platform. See [Open questions](#open-questions).
- For a record from another session code, `runSession()` in the workflow throws
  `SessionCodeMismatchError` before it changes anything. The engine maps that error to park or
  retire. It parks the session until a replica with that session code runs it, or it retires the
  session. This example does not show that code.

## Invariants

The sections above state each rule. This table gives the check that keeps each invariant. Two
invariants have no other section: an eve module does no I/O, sets no timer, and makes no random
value when it loads. New state for one application is a value of the app, not a new
`Symbol.for("eve.*")` global.

| Invariant                                                                                                                                                                          | Check                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| No code finds an app through a global. In a turn, code reads the app from the context of the turn. A step reads `startedApp()`. A process with no app reads `platform/process.ts`. | Guard rule 72                                                                                                            |
| The lifecycle is one ordered list, with rule 33 at its position                                                                                                                    | A test of the order, and guard rule 33                                                                                   |
| An entry build serves requests only with `AsyncLocalStorage`                                                                                                                       | The tests of `entry-app-runtime` and the `build-entry` scenario                                                          |
| Generic code does not read `VERCEL*` variables or import Vercel SDKs                                                                                                               | Guard rule 69                                                                                                            |
| Code outside `src/platform/` imports only the entity interfaces and the built-in value modules                                                                                     | Guard rule 70                                                                                                            |
| Only the generated platform module imports the built-in declaration                                                                                                                | Guard rule 76                                                                                                            |
| Only the Workflow engine uses a World                                                                                                                                              | Guard rule 71                                                                                                            |
| The session program does not import Workflow                                                                                                                                       | Guard rule 66                                                                                                            |
| The session program loads without Node                                                                                                                                             | Guard rule 74, and guard rule 73 for the web versions in `src/runtime-env/`                                              |
| The program imports no step function                                                                                                                                               | Guard rule 75, part 1                                                                                                    |
| The program reads no clock and makes no race outside `ProgramHost`                                                                                                                 | Guard rule 75, part 2                                                                                                    |
| Each engine keeps the engine rules                                                                                                                                                 | The session battery                                                                                                      |
| A run of the Workflow engine replays only on the same eve code                                                                                                                     | The step IDs, the session code hash, the guard with its classes, and a type that needs a class for each workflow (#6754) |
| The program replays its own runs                                                                                                                                                   | A replay test on a test World, and a test that boots a version 19 checkpoint of the previous build                       |
| A record replays only on the session code that wrote it                                                                                                                            | The tests of `session-code`                                                                                              |
| Stream routes read `Durable` when the engine sets no reader                                                                                                                        | The `stream-fallback` integration test                                                                                   |

## Implementation

The engine boundary comes from earlier work: the session core without Workflow (#6053) and the
session battery (#6352).

These pull requests implement steps 1 to 6b of this design. Items 12 and 13 fix the boundaries of
the internal types before step 6b. Each change up to item 13 is internal and has a patch
changeset. Step 6b adds the experimental public API, with a minor changeset. The first ten are the
stack of #6785.

1. This document (#6690).
2. The platform layer foundation (#6661).
3. The ports of the session record from #6455 and of the session core without Node from #6074,
   and the guard for Node imports (#6752).
4. Step 1: the app, the lifecycle, and the replay battery (#6756).
5. Step 2, and the session program without Node (#6758).
6. Step 3: the app goes to the routes, the steps, and the defaults (#6763).
7. Step 5: `Build.entry` (#6771).
8. Steps 4a and 4b: `Durable`, the session runtime, the step dispatcher, and the engine entries
   (#6775).
9. Step 4c: the clock through the host of the program, and the session code hash on each run
   (#6786).
10. Step 4d: the record as the contract of an engine, `StepMeta`, the content store, and
    `storeDurable()` (#6791).
11. Step 6a: the built-in Vercel declaration takes the path of a loaded platform (the pull request
    after #6791).
12. The platform fixes: one `Build.prewarm`, `Deployment.revision()`, and `App.hosts` split into
    hook routes and session streams, with `hostEngine()` (the pull requests after #6801).
13. The engine fixes: the Workflow work behind `Durable`, one stream sink, the signals only in
    `StepMeta`, and named hosts (the pull requests after #6801).
14. Step 6b: platform selection from `agent/platform.ts`, `eve/experimental/platform`, and
    `eve/experimental/session`, with the [user docs](../docs/experimental/platforms.md) (the pull
    request after the engine boundary fixes).
15. Four fixes in the step 6b pull request: `app.lifetime` for factories, streams through
    `Durable`, the session code in each record, and schedules through `Triggers`.

## Next steps

Steps 1 to 6b are done in the pull requests above. Step 4d makes the record the contract of an
engine. It adds `sessionSteps()`, the interrupts, `StepMeta`, the stream sink, and the content
store. It also adds `SessionStore` and `storeDurable()`. The platforms of the Cloudflare and
Temporal examples are not in this repository, by design. Each one is in its own package, and the
session battery runs on each. The battery of the Cloudflare platform runs in the Workers runtime.

**Step 6a: the built-in declaration takes the path of a loaded platform.** The build writes one
generated module, `compiled-artifacts-platform.mjs`. It imports the selected declaration and
registers it in `platform/process.ts`. `platform/selection.ts` selects the declaration. Since step
6b, this is `agent/platform.ts` when it exists, and else the Vercel declaration of eve. A build
option for tests selects a different module. The build reads `build` and the `build` of the
engine from that declaration. The server imports the declaration only through the generated
module.

- The platform phase calls `context()`, and it makes the entities with the result. The same
  value goes to each factory and to `DurableEngine.start()`.
- The durable phase starts `durable?.()`. Without `durable`, or when `durable` returns
  `workflowEngine()`, it starts the default Workflow engine. The generated module does not select
  an engine.
- No code reads the built-in declaration directly. Routes, turns, steps, and the boot phases
  read the app. Public getters read the app when code reads them. Route auth reads the app of
  the request, and `routeAuth()` keeps its public signature.
- A process with no app reads the entities from `platform/process.ts`. eve makes them one time
  for each process from the generated module.
- Code inside a step that has no app in its context reads the started app of the process. eve
  checks that the code runs in a step before it reads it.
- `localDev()`, `placeholderAuth()`, and the OIDC verdict can run in a process that has no app and
  no platform module. An example is a unit test of a user. There they see no platform facts. This
  is the one change in behavior of step 6a, and its changeset tells it.
- Guard rule 76 keeps this path. A scenario test builds with a test declaration on
  `storeDurable()`, and it serves a session over HTTP.

**Step 6b: platform selection.** This is the public part, and it is experimental. The user docs
are in [Platforms](../docs/experimental/platforms.md).

- eve selects `agent/platform.ts` when it exists, and else its built-in Vercel declaration. A
  default export that is not a declaration stops the build with an error that names the file.
  `eve dev` keeps its platform until a restart.
- `eve/experimental/platform` exports `definePlatform()`, the entity types, `registerCleanup()`,
  `endLifetime()`, `workflowEngine({ world })`, the `Durable` contract, `hostEngine()`,
  `sessionSteps()`, and `storeDurable()` with `SessionStore`. It also exports
  `deliverScheduleOccurrence()`, `runAuthoredSchedule()`, and their related types.
- `eve/experimental/session` exports `runSession()`, `ProgramHost`, `RunSessionHost`, and
  `sessionInbox()` with `SessionInboxSource`. It also exports `sessionCodeHash()`,
  `SessionCodeMismatchError`, the record, the run result, and the related types.
- The parts that step 6b needed first are built. They are `Network.fetchUntrusted`, the session
  timeouts on `storeDurable()`, the public inbox transport, and the selected `build` in Vite.
- Entity factories receive `app.lifetime`. Stream routes read `Durable` in each process when the
  engine sets no reader. Records carry their session code. `Triggers.register()` receives the
  authored schedules, and a provider runs a due occurrence from any process.
- The OIDC claims of `Identity` are an `OidcClaims` of eve.
- An integration test covers the selection. Scenario tests build and serve with a platform file,
  also in `eve dev`. The `agent-platform` e2e fixture saves memory through the `storage` of its
  platform. Integration tests cover the stream reader over `Durable` and the schedule functions.

These items remain:

- Authored workflows on an engine other than Workflow. An agent with authored workflows needs an
  engine with `runs`. See "Open questions".
- The generator form of the session program, also an open question.
- The Vite plugin reads the selected `build`, but one synchronous read of the Vercel `build`
  stays. It decides whether the plugin declares its `buildApp` hook.
- Two tools stay on Vercel: `runDiscordGatewayRelay()` without a `url`, and the model credential
  broker of `eve dev`. The user docs list them as limits.
- The other open questions below.

## Open questions

- Can a platform build on another, for example a base for one host with changes for one
  application?
  This design permits one declaration and no merge.
- Can the Workflow runtime run without Node? Then the Cloudflare platform can give only a World,
  through `workflowEngine()`, and not an engine of its own. The Temporal platform needs its own
  engine in each case.
- Authored workflows (`eve/workflow`) and workflow tool runs are a second program, with their own
  host (`RunHost` in `execution/run-host.ts`). Can eve compile each authored `"use workflow"` body
  to a program on `ProgramHost`? Each `"use step"` call becomes a `step()` call, with the export
  name as its name and the call order as its key. `sleep()` becomes `next({ until })`, and
  a hook becomes a delivery to an address of the run. Then each engine can run authored workflows,
  and `BuildContribution.runs` goes away. But then authored code must keep the rules of the
  program: no clock, no race, and no Node. eve checks these rules only for its own code.
- What are the commands of a generator form of the session program (`sessionProgram()` and
  `SessionCommand`)? Step 4c did not add it. A set of commands cannot express the waits that the
  engine owns without fork, join, and commands of the engine. Examples are the claims of the
  inbox, `moves`, the session timeout, the notice of an anchor, and the record. It also cannot
  express background work that the program joins later, for example a prewarm. The async
  `runSession()` with `RunSessionHost` serves each engine that this design examined, except Durable
  Task and Dapr. Design the commands when a platform for Durable Task or Dapr is written.
- The public API uses the word "world" in `experimental.workflow.world` and in about 18 docs pages.
  Which eve name replaces it?
- The `DefaultSandbox` option for a hosted sandbox is `vercel`. Which neutral key replaces it for
  other platforms?
- Nobody measured the cold start before and after this work. Is a measurement necessary before
  the platform API stops being experimental?

## Appendix: where the Vercel code of `main` goes

| Source on `main`                                                                                                              | Entity                      |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `VERCEL_ENV`, `VERCEL_TARGET_ENV`, `VERCEL_DEPLOYMENT_ID`, `VERCEL_URL`, `VERCEL_BRANCH_URL`, `VERCEL_PROJECT_PRODUCTION_URL` | `Deployment`                |
| `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF`, `VERCEL_DEPLOYMENT_CREATED_AT`                                              | `Deployment.revision`       |
| `vercelDeploymentId` in invocation data                                                                                       | `Deployment.invocationData` |
| `DurableHost`, `installDurableHost()`, `installWorkflowWorld()`, `WORKFLOW_DEPLOYMENT_ID`, the queue namespace                | The durable engine          |
| `vercelScheduleProvider()` as the default `provider`                                                                          | `Triggers`                  |
| The `@vercel/sandbox` bindings and their credentials                                                                          | `Compute`                   |
| `vercelBlob()` as the default backend of `fileMemory()`                                                                       | `Storage`                   |
| `acceptCurrentVercelProject` and `VERCEL_PROJECT_ID` in OIDC route auth                                                       | `Identity`                  |
| `VERCEL_OIDC_TOKEN` on callbacks, the `VERCEL_URL` transport of a workspace agent                                             | `Network`                   |
| The `agentRuns` span exporter, the `vercel.session_id` attribute                                                              | `Telemetry`                 |
| `resolveGatewayModelCredential()`                                                                                             | `Models`                    |
| The Vercel Nitro preset, `.vercel/output`, `vercel-build-prewarm.ts`                                                          | `Build`                     |
| `VERCEL_AUTOMATION_BYPASS_SECRET` and `VERCEL_TOKEN` in `eve dev` and the CLI                                                 | Outside the platform: tools |
