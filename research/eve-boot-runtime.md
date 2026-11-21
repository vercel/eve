---
issue: https://github.com/vercel/eve/pull/6661
status: proposed
last_updated: "2026-11-21"
---

# Platforms for eve

## Summary

eve runs on Vercel. The goal is that eve can also run on other platforms. Examples are a
self-hosted Node server, a Kubernetes cluster, and a runtime that has no Node process.

This document gives the internal design for that goal:

- **A platform is one file.** `agent/platform.ts` has a `definePlatform()` declaration. The
  declaration gives nine generic entities, for example `Durable`, `Compute`, and `Storage`. Each
  entity answers one question that eve asks. Generic code uses the entities and never asks which
  platform it runs on.
- **An application instance is a value.** The compiler makes an inert app, and `app.start()` makes
  a running app. The code that calls `start()` gives the running app to the code that it calls, so
  no code finds it through a global. Two running apps in one process share nothing.
- **eve runs a fixed lifecycle.** The order of the phases is a list. The author of a platform
  writes no order.
- **`Durable` hides the engine.** eve ships the Workflow engine, and a platform can write its own.
  Thus a platform can run eve without Workflow.

Two examples show the design in use. The first is a self-hosted Node server with the Postgres
World. The second uses only Cloudflare products, without Workflow. A platform for another host is
in its own package, outside this repository.

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
  deployment(running: RunningApp, context: C): Deployment;
  durable?(): DurableEngine<C>;
  triggers?(running: RunningApp, context: C): Triggers;
  compute?(running: RunningApp, context: C): Compute;
  storage?(running: RunningApp, context: C): Storage;
  identity?(running: RunningApp, context: C): Identity;
  network?(running: RunningApp, context: C): Network;
  telemetry?(running: RunningApp, context: C): Telemetry;
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
- The fields have no order. A factory that needs another entity reads it from the running app, and
  eve makes that entity first.
- `context()` gives the values that exist only at run time, for example the bindings that a
  runtime gives to a request handler. eve calls it one time for each running app, and it gives the
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
  start(running: RunningApp, context: C): Durable | Promise<Durable>; // opens resources at run time
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
  readonly outputDirectory?: string;
  sandboxPrewarmFailure?(error: unknown): Error | undefined;
}
```

Rules:

- A feature that only some platforms have is an optional member of its entity. Examples are
  `Durable.moves`, `Compute.credentialTransforms`, and `Network.peer`. Generic code does not
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
- With `entry`, eve builds the app. The module in `entry` imports `app` from `eve:app`, starts it,
  and serves `running.fetch()`. `waitUntil` keeps the work of a channel after the response, where
  the runtime permits it.
- The entry module also imports `eve:instrumentation`. It loads the instrumentation before the
  app, in the way that its runtime permits. A runtime that cannot wait for I/O while its
  modules load permits only synchronous setup.
- A file or an export that a host needs comes from the entry module. eve does not know these files
  and exports.
- The Vercel declaration uses an entry that is internal to eve.
- A platform for a host other than Vercel is in its own package. The code of eve does not name such
  hosts.

eve does not ask a platform which runtime it uses. Each part that needs a feature of the runtime
checks for the feature itself, and it stops when the feature is not there:

| Part                            | Check                                                                                                                                                         | When the check fails                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| The local World                 | It finds a disk when the engine starts.                                                                                                                       | The engine does not start. The error tells the author to add `durable`.      |
| The guard for outbound requests | Before its first request, it calls `fetch` with a test dispatcher that stops the call. The result shows if `fetch` uses the guard. No request goes to a host. | eve refuses the request, unless the platform gives `Network.fetchUntrusted`. |
| Connection drain                | It is part of the Node server of eve.                                                                                                                         | A platform entry does not get it.                                            |

### Out of scope

Model access is a separate change. The model credentials of the current contract stay where they
are until that change.

## How eve runs a platform

### The app and a running app

```ts
// The compiler makes the app from the agent directory and agent/platform.ts. It is inert data.
interface EveApp {
  start(): Promise<RunningApp>;
}

interface RunningApp {
  readonly platform: Entities; // each entity is made at its first read
  readonly durable: Durable; // the started engine
  fetch(
    request: Request,
    options?: { waitUntil?(work: Promise<unknown>): void },
  ): Promise<Response>;
}

function registerCleanup(target: object, cleanup: () => void | Promise<void>): void;
function tieTo<T extends object>(parent: object, child: T): T;
function stop(target: object): Promise<void>;
```

The compiler makes the app from the platform, the agent directory, and the defaults of eve. The app
does nothing until code calls `start()`. Rules:

- `start()` makes one running app and runs the lifecycle. Each call makes a new running app. Thus
  two running apps in one process share nothing.
- The code that calls `start()` keeps the running app, and it gives the running app to the code
  that it calls. No code finds a running app through a global or through `this`.
- An entity is made at its first read, and the running app keeps it. A factory that reads another
  entity makes that entity first. A cycle between two factories stops with an error that gives
  both entities.
- A factory runs one time for each running app. It receives the running app as an argument, and
  the value that it returns keeps the running app in its closure.
- A factory is synchronous. Work that must wait goes into `context()` or into
  `DurableEngine.start()`, which eve waits for.
- A value that can change inside one running app is a resolver, not a fixed value. The compiled
  artifacts are an example: `eve dev` can change them inside one worker.

Authored callbacks do not change. `execute(input, ctx)` receives a `ToolContext` as before. eve
makes that context for each call from the running app of the call.

### Cleanup

Cleanup is a tree, and the running app is its root:

- A factory that opens a resource calls `registerCleanup(running, cleanup)`.
- `tieTo(parent, child)` makes the cleanup of the child a part of the parent. eve ties each sandbox
  and each MCP connection to its session, and each session to the running app.
- `stop(target)` stops the children of the target first. Then it runs the cleanups of the target,
  in the opposite order of registration. `stop(running)` stops the full application.
- The end of a session stops the children of that session. Thus eve does not need a separate
  plugin for sandbox shutdown.

A host that discards a process or an isolate without notice does not call `stop()`. Thus cleanup
is not certain, and a platform does not depend on it for correct results.

### The lifecycle

`start()` runs one list of phases. The position in the list is the order:

| Phase                                    | Reason for its position                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| 1. Attach `agent/platform.ts`            | Each later phase can read the entities.                     |
| 2. Set the queue namespace               | Rule 33: before any code makes queue messages.              |
| 3. Install the compiled artifacts        | The agent directory and the sessions read them.             |
| 4. Call `context()`                      | Run-time values exist before a factory needs them.          |
| 5. Start the engine as `running.durable` | The Workflow engine reads `Deployment.deploymentId()`.      |
| 6. Install the instrumentation           | It reads `Telemetry`.                                       |
| 7. Load the agent directory              | Each tool, channel, memory, and schedule sees all entities. |

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

An entry point is code that a host calls. It holds a running app, or it receives one from the code
that started it:

| Entry point                                 | How it has the running app                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The Node server and the Vercel entry of eve | It calls `app.start()` one time and keeps the result. At shutdown, it calls `stop()`.                                   |
| HTTP request                                | The server calls `running.fetch()`. The route handlers receive the running app from `fetch()`.                          |
| A platform entry module                     | It imports `app` from `eve:app`. It calls `start()` at the first request, and it keeps the promise.                     |
| Engine or trigger code of a platform        | It uses the running app of its entry module. It gives the running app to `runSession()`, or it reads `running.durable`. |
| Workflow step                               | The generated step function reads the running app of its process.                                                       |
| Build                                       | It has no running app.                                                                                                  |
| OpenTelemetry                               | The running app makes the span processors, so they hold the running app in their closures.                              |
| Tests                                       | A test starts an app with a test platform, and it calls `stop()` after the test.                                        |

The Workflow SDK calls a step function with serialized input only. Thus eve cannot give the running
app to a step as an argument. A process that runs Workflow steps has one running app, so the
generated step function reads it:

```ts
// A step function. Its module path and its name do not change, so its step ID does not change:
export async function runTurnStep(input: TurnStepInput) {
  "use step";
  return turnStep(processApp(), input);
}
```

`processApp()` is internal. The Workflow engine records its running app for the process when it
starts, and a second Workflow engine in the same process stops with an error. Only the generated
step functions call `processApp()`. A scenario test must show that a step receives the running app
on the local World, the Postgres World, and Vercel Workflow.

## Durable

`Durable` is the generic interface for durable work. Generic code uses only this interface. It does
not see a World, a queue, or how an engine keeps sessions:

```ts
interface Durable {
  start(session: SessionStartInput): Promise<void>;
  deliver(to: DeliveryAddress, payload: unknown): Promise<void>;
  readStream(sessionId: string, from: number): AsyncIterable<StreamLine>;
  tail(sessionId: string): Promise<number>;
  status(runId: string): Promise<RunStatus | undefined>;
  cancel(runId: string, reason: string): Promise<void>;
  readonly moves?: SessionMoves;
}
```

- eve makes the session runtime from `Durable`. It is the `Runtime` interface that channels and
  routes use today. Thus each engine serves the same session protocol: NDJSON lines, line
  positions, `startIndex`, leases, and the tail index. Today `DurableHost.createRuntime()` makes
  the `Runtime` inside the engine.
- `deliver`, `status`, and `cancel` replace the other members of `DurableHost`. Each of those
  members has two or fewer callers outside the engines.
- `moves` is optional. Only an engine that can move a session to a new deployment has it. Today
  only Vercel Workflow can do this.

The `durable` field of the platform gives an engine. Phase 5 starts the engine as
`running.durable`. The engine can add to the build through `build`.

Each engine decides whether a run stays on the deployment that started it.
`Deployment.deploymentId()` is only a fact about the deployment. An engine can keep runs on their
deployment. Then the platform must keep the workers of each deployment until its runs end, or the
engine must have `moves`. Vercel Workflow keeps runs on their deployment and has `moves`. The
Postgres example below does not keep runs on a deployment, so each replica continues each run.

Each engine runs the session program. The session program does not import Workflow (#6053), and
guard rule 66 keeps it so. The program runs against `SessionHost`, which each engine supplies. The
session battery runs the same session tests on each engine (#6352). It is the conformance suite of
`Durable`.

Each engine keeps the rules that authors see. The rules are those of Workflow: a `"use workflow"`
body is deterministic, and a step can run more than one time.

### The Workflow engine

eve ships one engine:

```ts
function workflowEngine(options: { world: (running: RunningApp) => World }): DurableEngine;
```

"World" is the name that the Workflow SDK uses for its storage, queue, hooks, and streams. Only the
Workflow engine uses this name. The engine runs each session in a Workflow run, and it adds its step
bundles and its queue route to the build. It makes the World in `start()`, so a build makes no
World.

The `experimental.workflow.world` option of `agent.ts` stays. When the platform has no `durable`
field, eve uses `workflowEngine()` with the World from that option, or with the local
World. The local World needs a disk.

The Workflow engine modules can use the World directly. These are the binding directories and a
list of named modules, for example the session inbox and the session steps. The named modules stay
at their current paths. Workflow makes step IDs from the module path, so a move breaks the runs
that are in progress during a deploy. Guard rule 71 enforces this boundary.

### An engine that a platform writes

A platform can write its own engine, for example on a database of the platform. The engine
implements `DurableEngine`. eve gives it the session program:

```ts
function runSession(
  running: RunningApp,
  run: { boot: SessionBoot; inbox: SessionInbox; host: SessionHost },
): Promise<SessionRunResult>;

// The session program uses this interface today.
interface SessionHost {
  runTurnStep(input: TurnStepInput): Promise<TurnStepResult>;
  dispatchRuns(input: CoordinationDispatchInput): Promise<CoordinationDispatchResult>;
  applyRunMessages(input: ApplyRunMessagesInput): Promise<ApplyRunMessagesResult>;
  until(at: number): Promise<void>;
}
```

The session program already runs under Workflow replay, so it is deterministic between steps.
Thus an engine continues a session correctly when it gives back the results that it kept.

Rules for the engine:

- The engine keeps the result of each `SessionHost` method before the method returns.
- When a session runs again, for example after a crash, the engine calls `runSession()` again. Each
  method returns its kept result, in order. The first method without a kept result does its work.
- The inbox gives deliveries in the order that the engine kept. A replay gives them in the same
  order.
- The engine does not write a stream line again when a replay writes it.
- The engine can stop the run at `until()`. It runs the session again at that time.
- The engine runs one `runSession()` at a time for each session. A delivery or a due time starts
  the next run.
- The engine passes the session battery.

The engine calls `runSession()` with the running app as an argument.

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

- The running app and the entity interfaces import no implementation.
- Each built-in value is in a separate module. Only its factory imports it.
- Only an entry point imports `agent/platform.ts`.

### State that stays global

- **The running app of a Workflow process.** The generated step functions read it, because the
  Workflow SDK gives a step only serialized input. Only the Workflow engine records it.
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

  storage: (running) => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 10 });
    registerCleanup(running, () => pool.end());
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
3. `eve start` starts in each replica. The Node server of eve calls `app.start()`. Phase 5 starts
   the engine as `running.durable`.
4. The Workflow engine records the running app for the process, and it registers the direct queue
   handler. Graphile
   Worker gives each job to one replica, and the step runs in that replica.
5. An HTTP request reaches `running.fetch()`. A memory write uses
   the `storage` entity, which uses the pool that its factory opened.
6. At shutdown, the server calls `stop(running)`. It closes the pool and the World in the opposite
   order of registration.

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

| Rule for an engine                              | Durable Object                                             |
| ----------------------------------------------- | ---------------------------------------------------------- |
| One run at a time for each session              | One instance for each session ID. Calls run one at a time. |
| Keep each step result before the method returns | Write the result to SQLite before the method returns.      |
| Give back kept results in a replay              | Read the results from SQLite in order.                     |
| Keep the order of deliveries                    | A SQLite table with a sequence number                      |
| Do not write a stream line again                | The line position is the primary key.                      |
| A delivery or a due time starts the next run    | `ctx.storage.setAlarm()`                                   |

### The files

```text
agent/
  agent.ts
  platform.ts
  lib/engine.ts           # Durable: RPC to the EveSession objects
  lib/session-run.ts      # The boot, inbox, and SessionHost of one session, on SQLite
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

  deployment: (running, env) => ({
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
  triggers: (running, env) => ({ schedules: alarmSchedules(env.EVE_SCHEDULES) }),
  compute: (running, env) => cloudflareSandbox(env.EVE_SANDBOX),
  storage: (running, env) => ({ documents: r2Documents(env.EVE_MEMORY) }),
  identity: () => ({ verify: (request) => verifyAccessToken(request, "acme") }),
  network: (running, env) => ({
    peer: (name) => env[name],
    fetchUntrusted: (request) => fetch(request),
  }),
  build: { entry: "./lib/worker.ts" },
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

import { addressKey } from "./session-run";

export function durableObjectEngine(): DurableEngine<Env> {
  return {
    start(running, env) {
      const { EVE_SESSIONS: sessions, EVE_ADDRESSES: addresses } = env;
      const session = (sessionId: string) => sessions.getByName(sessionId);
      return {
        start: (input) => session(input.sessionId).start(input),
        async deliver(to, payload) {
          const sessionId = await addresses.getByName(addressKey(to)).find();
          if (sessionId === undefined) throw new Error(`No session holds "${addressKey(to)}".`);
          await session(sessionId).deliver(to, payload);
        },
        readStream: (sessionId, from) => session(sessionId).readStream(from),
        tail: (sessionId) => session(sessionId).tail(),
        status: (runId) => session(runId).status(),
        cancel: (runId, reason) => session(runId).cancel(reason),
      };
    },
  };
}
```

The engine reads the bindings in `start()`. Thus the build reads `durable` in Node without the
bindings. This engine has one run for each session, so the run ID is the session ID. It does not
set `moves`.

```ts title="agent/lib/worker.ts"
import "eve:instrumentation";
import app from "eve:app";
import { DurableObject } from "cloudflare:workers";
import {
  runSession,
  type RunningApp,
  type DeliveryAddress,
  type ScheduleRecord,
  type SessionStartInput,
} from "eve/platform";

import { nextOccurrence } from "./alarm-schedules";
import { sqliteSessionRun } from "./session-run";

let started: Promise<RunningApp> | undefined;
const running = () => (started ??= app.start());

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) =>
    (await running()).fetch(request, { waitUntil: (work) => ctx.waitUntil(work) }),
};

export class EveSession extends DurableObject<Env> {
  private run() {
    return sqliteSessionRun(this.ctx.storage.sql);
  }

  async start(input: SessionStartInput): Promise<void> {
    await this.run().begin(input, this.env.EVE_ADDRESSES);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async deliver(to: DeliveryAddress, payload: unknown): Promise<void> {
    this.run().enqueue(to, payload);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async readStream(from: number) {
    return this.run().linesFrom(from);
  }

  async tail(): Promise<number> {
    return this.run().tail();
  }

  async status() {
    return this.run().status();
  }

  async cancel(reason: string): Promise<void> {
    this.run().enqueueCancel(reason);
    await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const run = this.run();
    await runSession(await running(), run.toSessionRun());
    const wakeAt = run.nextWake();
    if (wakeAt !== undefined) await this.ctx.storage.setAlarm(wakeAt);
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
    await (await running()).durable.deliver(record.target, record.payload);
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

`sqliteSessionRun()` in `session-run.ts` keeps one session in the SQLite storage of its Durable
Object. `toSessionRun()` gives the boot, the inbox, and a `SessionHost` for `runSession()`. Each
`SessionHost` method reads its kept result first. When it has none, the method does its work and
keeps the result before it returns. `until()` keeps its time and stops the run, and `nextWake()`
returns that time. `begin()` claims the addresses of the session in `EveAddress` objects, and
`addressKey()` makes the key of an address.

`alarmSchedules()` is a `ScheduleProvider`. It keeps each schedule in the `EveSchedule` object of
its name, with the target from `ScheduleProviderContext`. `r2Documents()` and
`cloudflareSandbox()` follow the same pattern on R2 and on `EveSandbox`.

This table shows where each part fits into the design:

| Code                                       | Part of the design                                                        | Caller                               |
| ------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------ |
| The default export of `worker.ts`          | The entry (`Build.entry`): it starts the app and serves `running.fetch()` | Cloudflare, for each request         |
| `durableObjectEngine()` in `platform.ts`   | The `durable` field: a `DurableEngine` that the platform writes           | Phase 5 of the lifecycle             |
| `EveSession` RPC methods and `EveAddress`  | The storage behind `Durable`                                              | `durableObjectEngine()`, through RPC |
| `sqliteSessionRun().toSessionRun()`        | The boot, the inbox, and the `SessionHost` of one session                 | `runSession()`                       |
| `EveSession.alarm()`                       | Engine code: `runSession()` with the running app of `worker.ts`           | Cloudflare, when the alarm comes due |
| `alarmSchedules()` and `EveSchedule.put()` | The `triggers` field: the `Triggers` entity                               | The schedules client                 |
| `EveSchedule.alarm()`                      | Trigger code: `running.durable.deliver()`                                 | Cloudflare, when the alarm comes due |
| `cloudflareSandbox()` and `EveSandbox`     | The `compute` field: the `Compute` entity                                 | The code that opens a sandbox        |
| `r2Documents()`                            | The `storage` field: the `Storage` entity                                 | The memory file store                |
| `verifyAccessToken()`                      | The `identity` field: the `Identity` entity                               | OIDC route auth                      |
| The service binding lookup                 | The `network` field: `Network.peer`                                       | Calls to workspace agents            |
| The global `fetch`                         | The `network` field: `Network.fetchUntrusted`                             | `web_fetch` and session callbacks    |

### Boot and calls

1. `eve build` reads the declaration. It builds the app, and it bundles `worker.ts` around it.
2. `wrangler deploy` uploads the Worker, the Durable Object classes, and the sandbox image.
3. A user sends a message. The `fetch` handler of `worker.ts` starts the app at the first request
   of the isolate, and it gives each request to `running.fetch()`. The route calls the session
   runtime, which calls `Durable.deliver()`. The engine finds the session through
   its address, and it calls `EveSession.deliver()` through RPC.
4. `EveSession.deliver()` keeps the delivery in SQLite and sets the alarm. `EveSession.alarm()`
   calls `runSession()` with the running app.
5. The session program runs. Each `SessionHost` method keeps its result. When the program waits at
   `until()`, the run stops, and `alarm()` sets the next wake time.
6. A client reads the stream route. The session runtime calls `Durable.readStream()`. The NDJSON
   lines, positions, and leases are the same as on Vercel.
7. A dynamic schedule comes due. `EveSchedule.alarm()` delivers the occurrence through
   `running.durable.deliver()`.

An alarm that throws runs again later. The next run gives back the kept results, so the session
continues from its last kept step.

### What is not ready

| Part                         | Status                                                                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Durable` and `runSession()` | Not built (next step 4). Today `DurableHost.createRuntime()` makes the `Runtime` inside the engine.                                                                                        |
| `Build.entry`                | Not built (next step 5). The build must make the handler module that `worker.ts` imports.                                                                                                  |
| The Workflow engine          | This example writes its own engine. If the Workflow runtime can run without Node, the platform can give only a World. This is an open question.                                            |
| The engine of this example   | Not written. The session battery must pass on it. The battery runs in Node today, and it must also run in the Workers runtime.                                                             |
| Authored schedules           | `EveSchedule` serves dynamic schedules. Authored schedules need the same objects, made at deploy.                                                                                          |
| Long runs                    | An alarm handler has a time limit. A long run must stop after a kept step and continue in the next alarm. The kept results make this possible.                                             |
| Node APIs                    | Workers have `nodejs_compat`, but no processes and no local Docker. The Docker and `just-bash` sandboxes and the file store on disk do not work. The platform sets other entities instead. |
| Credential transforms        | Containers can intercept outbound requests. `Compute.credentialTransforms` is `false` until an adapter uses that feature.                                                                  |
| Instrumentation              | A Worker cannot wait for I/O while its modules load. Thus the setup of the instrumentation must be synchronous.                                                                            |
| Model access                 | Out of scope for this design.                                                                                                                                                              |

## Invariants

- No code finds a running app through a global or through `this`. The code that calls `start()`
  gives it to the code that it calls. A factory receives it as an argument.
- Only the generated Workflow step functions read the running app of the process (rule 72 changes
  to say this).
- Cleanup is a tree. A resource ties its cleanup to its parent, and `stop()` stops the children
  first.
- `agent/platform.ts` has one `definePlatform()` declaration. Phase 1 attaches it before eve loads
  the agent directory.
- The lifecycle is one ordered list, and a test checks it. Rule 33 and the order of the platform and
  the deployment ID are positions in that list.
- The build reads only `build` and the `build` of the engine. An engine opens resources only in
  `start()`.
- A value that can change inside a running app is a resolver.
- A `define*` function looks nothing up. The eve code that uses a definition does the lookups.
- Generic code uses the entities and does not compare platform names. A feature that only some
  platforms have is an optional member of its entity.
- Generic code does not ask which runtime it runs on. A part that needs a feature of the runtime
  checks for the feature, and it stops when the feature is not there.
- An eve module does no I/O, sets no timer, and makes no random value when it loads.
- Generic code uses `Durable` only. Only the Workflow engine uses a World.
- The session program does not import Workflow (rule 66). Each engine passes the session battery.
- Generic code does not read `VERCEL*` variables or import Vercel SDKs (rule 69).
- Code outside `src/platform/` imports only the entity interfaces and the built-in value modules
  (rule 70).
- Only the Workflow engine calls `getWorld()` or `setWorld()` (rule 71).
- New state for one application becomes a value of the running app. It does not become a new
  `Symbol.for("eve.*")` global.

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

These changes do not have the running app or the entities yet. A platform sits in one process slot,
and leaf code reads it through `platformContext()`. The services use a `hostServices()` builder, and
the runtime has fixed slots instead of names.

## Next steps

These steps are internal:

1. **The running app and the lifecycle.** Add `EveApp`, `start()`, the cleanup tree, and the ordered
   list of phases. Boot does the same work in the same order. The fixed runtime slots become values
   of the running app.
2. **The platform file.** Add `definePlatform()`, the nine entities, and the load of
   `agent/platform.ts`. Move the Vercel concepts into the Vercel declaration. Remove
   `PlatformContext` and `hostServices()`.
3. **Entry points and defaults.** Let each entry point start the app or receive it, and generate
   the Workflow step functions that read the running app of the process. Today
   `defineDynamicSchedules()` and `defineWorkspaceAgent()` read the platform when an author calls
   them. Move these reads, and the defaults of `DefaultSandbox` and
   `fileMemory()`, into the code that uses the definitions. Remove `platformContext()`, and
   change rule 72. Add the scenario test for the Workflow step functions.
4. **`Durable`.** Replace `DurableHost` with `Durable` and `workflowEngine()`. Make the session
   runtime from `Durable`, and add `runSession()` for engines that a platform writes. The lookups in
   `execution/hosts.ts` become values of the running app.
5. **A platform outside eve.** Add `Build.entry` and the checks of the runtime. Write the platform
   of the Cloudflare example in its own package, and run the session battery on it in the Workers
   runtime. This step tests the boundary.

This step comes after the internal steps:

6. **Platform selection.** An application must tell eve which platform it uses. This is the first
   public API. This design proposes `agent/platform.ts`. A build option is the
   alternative. This decision needs its own review.

## Open questions

- Can a platform build on another, for example a base for one host with changes for one
  application?
  This design permits one declaration and no merge.
- Can the Workflow runtime run without a Node process? If it can, a platform without Node gives
  only a World, and `Durable`, `runSession`, and `SessionHost` stay internal. If it cannot, these
  three become public API.
- Are `start()`, `RunningApp`, `registerCleanup()`, `tieTo()`, and `stop()` good names?
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
