---
title: "Workflow Worlds"
description: "Choose and configure the Workflow world that stores and resumes eve sessions on a self-hosted deployment."
---

A Workflow world is the backend that stores eve sessions so they survive restarts and redeploys. eve runs every session as a [Workflow SDK](https://workflow-sdk.dev/) workflow. The world stores each run's event log, step results, pending input, and streams, and queues the work that resumes it. eve uses Vercel Workflow on Vercel and the local world for `eve start`. A self-hosted deployment can select another world package without changing the agent.

## Compare worlds

| World                               | Storage                           | Processes              | After an eve version upgrade                                                                       |
| ----------------------------------- | --------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| [Local](#use-the-local-world)       | Files under `.eve/.workflow-data` | One                    | Existing sessions cannot resume                                                                    |
| [Postgres](#use-the-postgres-world) | A PostgreSQL database             | Any number of replicas | Existing sessions cannot resume                                                                    |
| [Vercel Workflow](./vercel)         | Managed by Vercel                 | Managed by Vercel      | Runs continue on their original deployments; eligible idle sessions can move to the new deployment |

On the local and Postgres worlds, a new build on the same eve version resumes existing sessions. See [Upgrade a self-hosted agent](./self-hosted-operations#upgrade-a-self-hosted-agent) for what happens when the eve version changes.

All three support compaction handoff, which moves a session to a fresh run while keeping its ID, event stream, and addresses; the Postgres world needs `@workflow/world-postgres` 5.0.4 or later. Vercel Workflow also supports moving eligible idle sessions between deployments. See [Execution model and durability](../../concepts/execution-model-and-durability#compaction-handoff).

## Use the local world

The local world is the default for `eve start` and needs no configuration. It stores run state under `.eve/.workflow-data` in the app directory. Mount that directory on persistent storage so runs survive process and container replacement.

Each `eve start` process accepts queue messages only from its own queue. Don't point `WORKFLOW_LOCAL_BASE_URL` at a load balancer, because another replica rejects forwarded messages with HTTP 401. To serve an agent from several replicas, use the [Postgres world](#use-the-postgres-world).

On startup, `eve start` queues pending and running local workflow runs again. Runs that were active when the previous process stopped continue when the eve version is unchanged. `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS=0` or `false` doesn't disable this recovery.

## Use the Postgres world

The [`@workflow/world-postgres`](https://www.npmjs.com/package/@workflow/world-postgres) package stores runs in PostgreSQL and queues their work with Graphile Worker. Every `eve start` process connected to the same database processes queued work, so you can run several replicas behind a load balancer.

1. Install the package in your app:

   ```bash
   pnpm add @workflow/world-postgres
   ```

2. Select it in the root `agent.ts`:

   ```typescript title="agent/agent.ts"
   import { defineAgent } from "eve";

   export default defineAgent({
     model: "anthropic/claude-opus-5.5",
     experimental: {
       workflow: {
         world: "@workflow/world-postgres",
       },
     },
   });
   ```

3. Set the connection string in the runtime environment with `WORKFLOW_POSTGRES_URL`. The package also reads `DATABASE_URL`. When neither is set, it connects to `postgres://world:world@localhost:5432/world`.

4. Create the schema before the first start:

   ```bash
   pnpm exec bootstrap
   ```

   With npm, run `npx --package @workflow/world-postgres bootstrap`. The command reads the same connection variables. Run it again before you start a build that upgrades `@workflow/world-postgres`, so the database has the new version's migrations.

5. Build and start the server as usual with `eve build` and `eve start`.

### Tune the Postgres world

The package reads these optional variables:

| Variable                               | Default | Description                                      |
| -------------------------------------- | ------- | ------------------------------------------------ |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | `50`    | Queued jobs each process runs at once            |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE`      | `10`    | Connections in each process's database pool      |
| `WORKFLOW_POSTGRES_POLL_INTERVAL_MS`   | `500`   | Milliseconds between idle job fetches per worker |

Graphile Worker recommends a pool size of at least the worker concurrency plus 2. With the default concurrency, set `WORKFLOW_POSTGRES_MAX_POOL_SIZE=52`, and size the database's connection limit for every replica's pool. See the [package README](https://www.npmjs.com/package/@workflow/world-postgres) for the full list.

The Postgres world stores workflow inputs, outputs, and stream contents in the database without encryption, and it keeps the records of finished runs until you delete them. Protect database access and backups, and see [Manage run data](./self-hosted-operations#manage-run-data) for retention.

## Use another world

Select any installed Workflow world package in the root `agent.ts`:

```typescript title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  experimental: {
    workflow: {
      world: "@acme/eve-workflow-world",
    },
  },
});
```

The package must export a default factory or `createWorld()` function. It reads credentials and host options from runtime environment variables, not `agent.ts`. If the package must stay external in hosted output, list it in `build.externalDependencies`.

Install a world built against the same `@workflow/*` major version as your eve release, currently `5.x`. eve checks the world's `@workflow/core` or `@workflow/world` dependency at startup, and fails with the version to install when the major versions differ.

See [Workflow Worlds](https://workflow-sdk.dev/worlds) for the Workflow SDK abstraction, and [agent.ts](../../agent-config#workflow-world) for the configuration field.
