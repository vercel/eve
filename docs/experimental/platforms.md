---
title: "Platforms"
description: "Tell eve where your agent runs with agent/platform.ts: the deployment, storage, identity, network, and the durable engine that runs sessions."
---

A platform tells eve where your agent runs: the deployment, the storage, the callers, and the durable engine of sessions. You declare it in `agent/platform.ts`. Without that file, eve uses its built-in Vercel platform, which also works off Vercel.

Platforms are experimental and may change in any release. Import the platform API from `eve/experimental/platform` and the session program API from `eve/experimental/session`.

## Declare a platform

```text
agent/
  agent.ts
  platform.ts
```

```ts title="agent/platform.ts"
import { inMemory } from "eve/memory/file";
import { definePlatform } from "eve/experimental/platform";

export default definePlatform({
  // required: the facts of this deployment
  deployment: () => ({
    environment: () => "production",
    deploymentId: () => process.env.DEPLOYMENT_ID,
    productionHost: () => "agent.example.com",
    publicHost: () => "agent.example.com",
    scope: () => ({
      platform: "example",
      id: "notes-agent",
      environment: "production",
      variant: null,
    }),
  }),
  // optional: the default backend of fileMemory()
  storage: () => ({ documents: inMemory() }),
});
```

The default export must be the result of `definePlatform()`. Any other default export stops the build.

## How eve loads the platform

- `eve build` and `eve dev` load `agent/platform.ts` when it exists, and use the built-in Vercel platform otherwise. `eve start` serves the platform that the build selected.
- The build runs the file in Node. It reads only `build` and the `build` of the engine that `durable()` returns. It never calls `context()` or an entity factory.
- The server calls `context()` one time when the app starts. It passes the result to each factory and to the engine's `start()`.
- `agent/platform.ts` loads in the build and in the server. Import a module that only the server has inside `context()`, not at the top of the file.
- `eve dev` keeps the platform that it started with. Restart `eve dev` after you change `agent/platform.ts`.

## Entities

Each field of `definePlatform()` is a factory for one entity. A factory receives the app and the value of `context()`. The app has the other entities on `app.platform` and the app's lifetime on `app.lifetime`. Omit a field to keep its default.

To close a client that a factory opens, such as a database pool, register its cleanup with `registerCleanup(app.lifetime, ...)`. eve runs it when the app stops.

| Field        | What it tells eve                                    | When you omit it                                                                                  |
| ------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `deployment` | The environment, deployment ID, hosts, and scope     | Required.                                                                                         |
| `triggers`   | The service that keeps and fires schedules           | `defineDynamicSchedules()` needs its own `provider`, and eve's scheduler runs authored schedules. |
| `compute`    | The hosted sandbox for untrusted code                | `DefaultSandbox` uses Docker when a Linux Docker daemon is there, then `just-bash` in `eve dev`.  |
| `storage`    | The default document backend of `fileMemory()`       | `fileMemory()` uses the development store in `eve dev`, and needs its own `backend` elsewhere.    |
| `identity`   | Checks of callers that come in, such as OIDC callers | OIDC route auth verifies the token and the claim matchers of the route.                           |
| `network`    | Callback headers, workspace agent transport, tokens  | Callbacks carry no platform headers, and `defineWorkspaceAgent()` needs its own `transport`.      |
| `telemetry`  | A span processor and the session span attribute      | Traces go only where the agent's instrumentation sends them.                                      |
| `models`     | Model credentials in development                     | The model needs its own credential, such as `AI_GATEWAY_API_KEY`.                                 |
| `durable`    | The durable engine that runs sessions                | eve runs the Workflow engine with the World from `agent.ts`, or the local World.                  |
| `build`      | How eve packages the application                     | eve builds its Node server.                                                                       |

`build` is data, not a factory, because the build reads it. `build.prewarm` names the hosted sandbox that the build prewarms. `build.schedules.kind` names the default schedule provider kind for `defineDynamicSchedules()`. `build.schedules.authored` gives authored schedules to the platform's `triggers`.

## Give run-time values with context()

Use `context()` for values that exist only when the server runs, such as the bindings of a runtime. eve calls it one time for each app.

```ts title="agent/platform.ts"
import { definePlatform } from "eve/experimental/platform";

export default definePlatform({
  context: async () => ({ region: process.env.REGION ?? "local" }),
  deployment: (_app, context) => ({
    environment: () => "production",
    deploymentId: () => `notes-${context.region}`,
    productionHost: () => undefined,
    publicHost: () => undefined,
    scope: () => undefined,
  }),
});
```

## Choose the Workflow World

Return `workflowEngine()` from `durable` to choose the [Workflow World](/docs/guides/deployment/workflow-worlds) in the platform:

```ts title="agent/platform.ts"
import { definePlatform, workflowEngine } from "eve/experimental/platform";

export default definePlatform({
  deployment: () => ({
    environment: () => "production",
    deploymentId: () => undefined,
    productionHost: () => undefined,
    publicHost: () => undefined,
    scope: () => undefined,
  }),
  durable: () => workflowEngine({ world: "@workflow/world-postgres" }),
});
```

Set the World in `agent.ts` or in the platform. When both name a World and they differ, the build stops.

## Write a durable engine

A durable engine keeps sessions and runs them. It implements `DurableEngine`:

- `build` is data that the build reads, such as `entries`, the server entries of the engine by name.
- `start(app, context)` opens the engine's resources and returns a `Durable`. Close them with `registerCleanup(app.lifetime, ...)`.
- `hostEngine(app)` serves the engine's hook routes and session streams through eve's routes. Each registration ends with the app.
- When this process registered no stream for a session, eve serves its stream from `Durable.readStream()` and `Durable.tail()`. Thus a stream request can land in any process of the engine.

The engine runs eve's session program with `runSession()` from `eve/experimental/session`, inside its own durable function. `runSession()` runs a session until it ends, parks, or moves:

- A parked run returns a record. Keep it with the last inbox position, and pass it back at the next run.
- A parked run can return `wakeAt`. Run the session again at that time, even when no input arrives.
- A record replays only on the eve build that wrote it. `sessionCodeHash()` returns the session code of this build. For a record from another session code, `runSession()` throws `SessionCodeMismatchError` and changes nothing. Park the session until a deployment with that session code runs it, or retire the session.
- `sessionInbox(sessionId, source, { throughSeq })` makes the inbox that `runSession()` reads from the engine's own inbox: `itemsAfter()`, `arrival()`, and `claim()`.

`sessionSteps(app, options)` returns eve's session steps. Call `steps.run(name, input, meta)` from the engine's durable steps.

## Keep sessions in a store

`storeDurable()` makes an engine from a `SessionStore`, for an engine that keeps sessions in a database. It implements `Durable`, the inbox, and records. Your engine gives the store and a `wake` function:

```ts title="agent/lib/engine.ts"
import { storeDurable, type DurableEngine, type SessionStore } from "eve/experimental/platform";

export function storeEngine(
  store: SessionStore,
  schedule: (sessionId: string, at: number | undefined) => Promise<void>,
): DurableEngine {
  return {
    start() {
      const engine = storeDurable({
        store,
        // run the session now, or at options.at; your worker calls engine.run(sessionId, host)
        wake: (sessionId, options) => schedule(sessionId, options?.at),
      });
      return engine.durable;
    },
  };
}
```

`wake(sessionId, { at })` asks for a run at a time, such as the end of an idle sandbox window or the session timeout. The default session timeout is 30 days, which is longer than one Node.js `setTimeout()` can wait. Schedule far wakes in a store or a scheduler, or wait in parts.

A wake can come while `run()` still runs the same session. Your engine can drop that wake. Before `run()` parks, `storeDurable()` runs the session again for input or a wake time that came during the run.

## Run schedules in the platform

A schedule service can fire in any process of the app. Hand each due occurrence to eve with a function from `eve/experimental/platform`:

- `deliverScheduleOccurrence(app, { payload, occurrence })` runs an occurrence of a dynamic schedule. Pass the `payload` that the provider's `create()` stored.
- `runAuthoredSchedule(app, name)` runs an authored schedule from `agent/schedules/`.

To run authored schedules with your service, set `build.schedules.authored` and give `triggers.register()`:

```ts title="agent/platform.ts"
import { definePlatform } from "eve/experimental/platform";

import { cronService } from "./lib/cron-service.js";

export default definePlatform({
  deployment: () => ({
    environment: () => "production",
    deploymentId: () => undefined,
    productionHost: () => undefined,
    publicHost: () => undefined,
    scope: () => undefined,
  }),
  triggers: () => ({
    schedules: cronService.provider,
    // each process calls register() when the app starts, so keep it idempotent
    register: (schedules) => cronService.upsert(schedules),
  }),
  build: { schedules: { authored: true } },
});
```

eve then adds no scheduled tasks of its own to the build, and an entry build can have authored schedules. When a schedule comes due, call `runAuthoredSchedule(app, schedule.name)`. In `eve dev`, eve's local scheduler runs authored schedules.

## Limits

- The server of an `eve build` serves only the routes of the Workflow engine. An engine that you write serves its work through `build.entries`.
- An agent with authored workflows needs an engine that runs them, such as the Workflow engine.
- On a runtime without the Node.js network modules, eve refuses untrusted URLs, such as `web_fetch` targets, unless `network.fetchUntrusted` fetches them.
- Two tools stay on Vercel whatever the platform gives. `runDiscordGatewayRelay()` reads `VERCEL_PROJECT_PRODUCTION_URL` when you pass no `url`. The `eve dev` model credential broker reads AI Gateway credentials through Vercel.

## Troubleshooting

| What you see                                                                                                        | What to do                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `The default export of "agent/platform.ts" is not a platform declaration.`                                          | Export the result of `definePlatform()` as the default export, or delete the file to use the built-in platform. |
| `agent.ts sets experimental.workflow.world to "...", and agent/platform.ts gives workflowEngine({ world: "..." }).` | Set the World in one of the two files.                                                                          |
| `The schedule collection in "..." has no provider, and the platform names no default.`                              | Pass `provider` to `defineDynamicSchedules()`, or give `build.schedules` in the platform.                       |
| ``An authored schedule needs eve's Node server or the platform's `Triggers` ``                                      | Set `build.schedules.authored` and give `triggers.register()` in the platform, or build without `build.entry`.  |
| `eve dev` still uses the old platform after you edit `agent/platform.ts`                                            | Restart `eve dev`, because it keeps the platform that it started with.                                          |

## Related pages

To run eve's Node server on your own infrastructure without a platform file, see [Self-host eve](/docs/guides/deployment/self-hosting). To choose a World without a platform, see [Workflow worlds](/docs/guides/deployment/workflow-worlds).
