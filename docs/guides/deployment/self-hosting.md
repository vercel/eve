---
title: "Self-Host eve"
description: "Run an eve agent as a Node service on your own infrastructure, and choose the Workflow world and sandbox it uses."
---

Self-host eve by running the Node server that `eve build` produces on your own servers, container platform, or behind your own reverse proxy. The server runs every session as a durable workflow, so conversations, human approvals, and subagent work survive process restarts. eve backs that durability with a [Workflow world](./workflow-worlds) and runs shell and file tools in a [sandbox](../../sandbox). Both have self-hosted defaults, and you can replace either one without changing your agent's behavior.

## What a self-hosted deployment needs

Every self-hosted deployment needs:

- A model credential and a production route policy; see [Configure model access and route auth](#configure-model-access-and-route-auth)
- Persistent storage for the Workflow world; see [Choose a Workflow world](#choose-a-workflow-world)
- A Node process serving the build; see [Build and start the server](#build-and-start-the-server)
- A reverse proxy that forwards both runtime route prefixes; see [Configure proxy routes](#configure-proxy-routes)

The sections below follow that order and end by verifying a real turn. Configure [additional features](#configure-additional-features) as your agent needs them.

## Configure model access and route auth

Set `AI_GATEWAY_API_KEY` to use a string model ID through the Vercel AI Gateway. To call a provider directly, install its [AI SDK provider package](https://ai-sdk.dev/docs/foundations/providers-and-models), pass its model object in `agent.ts`, and set its API key. See [Agent configuration](../../agent-config#set-the-model) for examples.

Outside Vercel, use an authenticator your host can validate as the production route policy, such as Basic auth, JSON Web Token (JWT) verification, generic OpenID Connect (OIDC), or a custom verifier, rather than `vercelOidc()` alone. See [Authentication](../auth-and-route-protection).

## Choose a Workflow world

For one process, use the default local world. It needs no configuration and stores session state under `.eve/.workflow-data`; mount that directory on persistent storage so sessions survive process and container replacement. For replicas or hosts without persistent disk, configure the [Postgres world](./workflow-worlds#use-the-postgres-world). To use your own world implementation, see [Use another world](./workflow-worlds#use-another-world).

See [Workflow worlds](./workflow-worlds) to compare and configure the available worlds.

## Build and start the server

If your agent uses sandbox tools or file attachments, make Docker available during the build and at runtime, or [select a sandbox provider explicitly](#run-the-sandbox). For Dockerfile builds, see [Build inside a container image](#build-inside-a-container-image) below.

```bash
eve build
PORT=3000 eve start --host 0.0.0.0
```

The build writes the eve server under `.output/`. `eve start` serves that output and accepts either `PORT` or the `--port` flag. To run the server from another directory, copy the app source, `.output/`, and installed dependencies together.

The output is a standard [Nitro](https://nitro.build) Node server. If you adapt it to a host or preset instead of running `eve start`, see [Run schedules](./self-hosted-operations#run-schedules).

Run the process under the same process manager or container platform you use for other Node web services, and configure Transport Layer Security (TLS), restarts, and log collection there.

### Build inside a container image

A `RUN eve build` step in a Dockerfile usually has no Docker daemon, so the build records no sandbox provider, even when the running container later mounts `/var/run/docker.sock`. Select `DockerSandbox.environment()` explicitly in that setup:

```typescript title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.environment();
export default defineSandbox(() => environment.open());
```

You can instead run `eve build` where Docker is reachable and copy the output into the image. See [Run the sandbox](#run-the-sandbox) for the other providers.

## Authenticate workflow deliveries

Postgres and other custom Workflow worlds require `EVE_WORKFLOW_DELIVERY_SECRET`. Generate a random value of at least 32 characters, for example with `openssl rand -hex 32`, store it in your secret manager, and set the same value on every server process connected to the world. The server exits at startup when the variable is unset, including when you deploy a custom world to Vercel. The built-in local world generates its own secret for each process, and Vercel Workflow authenticates deliveries itself.

When eve queues a workflow job, it signs the job's queue name and message with the secret and stores the signature in the job's `x-eve-workflow-delivery` header. Before it runs a delivery, eve checks that signature against the message it received and answers HTTP 401 when they don't match. This check is separate from [channel route auth](../auth-and-route-protection), and it applies whether the world delivers a job inside the process or over HTTP to another replica. Use HTTPS when deliveries cross hosts.

The secret itself never leaves your processes. Anyone who can read the queue, its logs, or its backups sees only signatures, which let them resend a job that was already queued but not create one with different input. A job queued without eve, for example by a script that imports the world package directly, has no signature and is rejected. Custom worlds must deliver each job with the headers eve queued it with.

To rotate the secret without interrupting deliveries:

1. Set `EVE_WORKFLOW_DELIVERY_SECRET=old_secret,new_secret` on every process. Processes accept both secrets and still sign new jobs with `old_secret`.
2. After every process accepts both, set `new_secret,old_secret` so new jobs are signed with `new_secret`.
3. Remove `old_secret` after every process has switched and the jobs signed with it have finished.

A queued job whose secret is no longer accepted fails each delivery attempt with HTTP 401 until the world stops retrying it. Jobs queued by an eve version without delivery signatures fail the same way after you upgrade. At startup, eve queues every active run again with a current signature, so runs that the [eve-version requirements](./self-hosted-operations#upgrade-a-self-hosted-agent) allow to resume do resume.

When the variable is unset, `eve dev` and a local `eve eval` share a generated secret stored in `.eve/workflow-delivery-secret`, so they can run beside each other against one database.

## Configure proxy routes

Forward both runtime route prefixes through your reverse proxy or ingress without rewriting their paths:

- `/eve/` serves health, sessions, streams, channels, tools, and subagents
- `/.well-known/workflow/` receives workflow callbacks

If the proxy forwards only `/eve/`, a session starts but the run stalls because its workflow callback can’t reach eve.

eve rejects queue deliveries without a valid [delivery signature](#authenticate-workflow-deliveries), independently of channel route auth. Public Workflow webhook routes keep their own authorization.

## Verify the service

After your proxy and authentication are active, check the health route:

```bash
curl https://your_agent.example.com/eve/v1/health
```

Then connect the development TUI and complete a real turn:

```bash
eve remote connect --url https://your_agent.example.com
```

## Configure additional features

| Feature                                                               | Configuration                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sandbox tools, file attachments, and skill supporting files           | [Run the sandbox](#run-the-sandbox) with Docker or another provider                         |
| [Schedules](../../schedules)                                          | Keep schedules enabled on [one `eve start` process](./self-hosted-operations#run-schedules) |
| Slack, Microsoft Teams, and other [channels](../../channels/overview) | Expose `/eve/` over public HTTPS through your [proxy](#configure-proxy-routes)              |
| Connection sign-in and [remote agents](../remote-agents)              | Set a [public callback origin](#set-the-public-callback-origin)                             |
| Agents in a workspace that call each other                            | Configure a [workspace-peer transport](../../subagents#vercel-workspace-peers)              |
| Traces                                                                | Configure an [OpenTelemetry](../../observability/otel) destination                          |

## Run the sandbox

eve runs the sandbox in Docker when `eve build` can reach a Docker daemon, and records that choice in the build.

A session starts its sandbox when a tool, a file attachment, or a skill's supporting files need it, and early when a client [prewarms](../frontend/use-eve-agent#prewarming) the session. Sessions, approvals, subagents, schedules, and authored tools that don't call `ctx.getSandbox()` work without a sandbox. Without one, a file attachment reaches the model as a text note instead of a file.

To run sandboxes elsewhere, or when the build cannot reach Docker, select a provider in your sandbox module:

- `VercelSandbox.environment()` creates hosted [Vercel Sandbox](../../sandbox/vercel) sessions from any host. Outside Vercel and without a linked project, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.
- `DockerSandbox.environment()` from `eve/sandbox/docker` selects [Docker](../../sandbox/docker) regardless of what the build can reach.
- `defineSandboxProvider()` connects a [custom provider](../../sandbox/custom-providers), such as your own container, virtual machine, or isolation service.

See [Sandbox](../../sandbox) for provider configuration and selection order.

## Set the public callback origin

Connection sign-in links and the callback URLs a parent passes to [remote agents](../remote-agents) start from the server's own address, which is `http://localhost:<port>` outside Vercel. Set `WORKFLOW_LOCAL_BASE_URL` to the agent's public origin, such as `https://support.example.com`, when your agent uses either feature:

```bash
WORKFLOW_LOCAL_BASE_URL=https://support.example.com eve start --host 0.0.0.0
```

With the local world, queued work is also delivered to that origin, so those deliveries pass through your proxy. Forward both [proxy route prefixes](#configure-proxy-routes), and keep a single process behind that origin; see [Use the local world](./workflow-worlds#use-the-local-world). The Postgres world usually delivers queued work inside each process; deliveries it sends over HTTP also use this origin and carry a [delivery signature](#authenticate-workflow-deliveries).

For an agent mounted under a path prefix, also set `EVE_PUBLIC_ROUTE_PREFIX`; see [Run workspace members](./self-hosted-operations#run-workspace-members).

## Continue configuring production

Use these guides to scale, secure, and observe the deployed agent:

- [Workflow worlds](./workflow-worlds): configure the local, Postgres, or another world
- [Operate a self-hosted agent](./self-hosted-operations): upgrade builds, run replicas and schedules, and troubleshoot
- [Authentication](../auth-and-route-protection): configure the host’s route policy
- [Instrumentation](../../observability/instrumentation): export traces and diagnose runtime failures
- [Sandbox](../../sandbox): select and secure a sandbox provider
