---
title: "Self-Host eve"
description: "Run an eve agent as a Node service on your own infrastructure, and choose the Workflow world and sandbox it uses."
---

Self-host eve by running the Node server that `eve build` produces on your own servers, container platform, or behind your own reverse proxy. The server runs every session as a durable workflow, so sessions, human approvals, subagents, and schedules survive process restarts. eve backs that durability with a [Workflow world](./workflow-worlds) and runs shell and file tools in a [sandbox](../../sandbox). Both have self-hosted defaults, and you can replace either one without changing your agent.

## Build and start the server

Build the agent, then start the generated server:

```bash
eve build
PORT=3000 eve start --host 0.0.0.0
```

The build writes a standard Nitro server under `.output/`. `eve start` serves that output and accepts either `PORT` or the `--port` flag. To run the server from another directory, copy the app source, `.output/`, and installed dependencies together.

This is a complete deployment. The default local Workflow world stores session state under `.eve/.workflow-data`, and the default sandbox runs in Docker when `eve build` can reach a Docker daemon. Mount `.eve/.workflow-data` on persistent storage so sessions survive process and container replacement.

Run the process under the same process manager or container platform you use for other Node web services, and configure Transport Layer Security (TLS), restarts, and log collection there.

## What a self-hosted deployment needs

Every self-hosted deployment needs a Node process, a model credential, a production route authentication policy, and durable storage for its Workflow world. Other infrastructure depends on the features your agent uses:

| Feature                                                                                       | What your host provides                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Durable sessions, human approvals, subagents, and tasks                                       | Storage for the Workflow world: a persistent directory or a Postgres database         |
| The `bash`, `read_file`, and `write_file` tools, file attachments, and skill supporting files | A sandbox provider; Docker by default                                                 |
| [Schedules](../../schedules)                                                                  | One `eve start` process with schedules enabled                                        |
| Slack, Microsoft Teams, and other [channels](../../channels/overview)                         | Public HTTPS access to `/eve/`                                                        |
| Connection sign-in and [remote agents](../remote-agents)                                      | A [public callback origin](#set-the-public-callback-origin)                           |
| More than one replica                                                                         | A shared Workflow world, such as [Postgres](./workflow-worlds#use-the-postgres-world) |
| Agents in a workspace that call each other                                                    | A [workspace-peer transport](../../subagents#vercel-workspace-peers)                  |
| Traces                                                                                        | An [OpenTelemetry](../../observability/otel) destination                              |

## Choose a Workflow world

The Workflow world stores each session's event log, step results, pending input, and streams, and queues the work that resumes it. Choose it by how many processes serve the agent:

| World                                                | Storage                           | Use it when                                                             |
| ---------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| [Local](./workflow-worlds#use-the-local-world)       | Files under `.eve/.workflow-data` | One process serves the agent from a persistent directory                |
| [Postgres](./workflow-worlds#use-the-postgres-world) | A PostgreSQL database             | Several replicas serve the agent, or containers have no persistent disk |
| [Another world](./workflow-worlds#use-another-world) | Defined by the world package      | You run your own Workflow world implementation                          |

The local world is the default and needs no configuration. See [Workflow worlds](./workflow-worlds) to configure each one.

## Run the sandbox

eve runs the sandbox in Docker when `eve build` can reach a Docker daemon, and records that choice in the build.

A session starts its sandbox when a tool, a file attachment, or a skill's supporting files need it, and early when a client [prewarms](../frontend/use-eve-agent#prewarming) the session. Sessions, approvals, subagents, schedules, and authored tools that don't call `ctx.getSandbox()` work without a sandbox. Without one, a file attachment reaches the model as a text note instead of a file.

To run sandboxes elsewhere, select a provider in your sandbox module:

- `VercelSandbox.environment()` creates hosted [Vercel Sandbox](../../sandbox/vercel) sessions from any host. Outside Vercel and without a linked project, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.
- `DockerSandbox.environment()` from `eve/sandbox/docker` selects [Docker](../../sandbox/docker) regardless of what the build can reach.
- `defineSandboxProvider()` connects a [custom provider](../../sandbox/custom-providers), such as your own container, virtual machine, or isolation service.

### Build inside a container image

A `RUN eve build` step in a Dockerfile usually has no Docker daemon, so the build records no sandbox provider, even when the running container later mounts `/var/run/docker.sock`. Select `DockerSandbox.environment()` explicitly in that setup:

```typescript title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { DockerSandbox } from "eve/sandbox/docker";

export const environment = DockerSandbox.environment();
export default defineSandbox(() => environment.open());
```

You can instead run `eve build` where Docker is reachable and copy the output into the image. See [Sandbox](../../sandbox) for provider configuration and selection order.

## Configure model access and route auth

Set `AI_GATEWAY_API_KEY` to use a string model ID through the Vercel AI Gateway from a non-Vercel host. To call a provider directly, install its [AI SDK provider package](https://ai-sdk.dev/docs/foundations/providers-and-models). Then pass its model object in `agent.ts` and set its API key. See [Agent configuration](../../agent-config#set-the-model) for examples.

Outside Vercel, use an authenticator your host can validate as the production route policy, such as Basic auth, JSON Web Token (JWT) verification, generic OpenID Connect (OIDC), or a custom verifier, rather than `vercelOidc()` alone. See [Authentication](../auth-and-route-protection).

## Configure proxy routes

Forward both runtime route prefixes through your reverse proxy or ingress:

- `/eve/` serves health, sessions, streams, channels, tools, and subagents
- `/.well-known/workflow/` receives workflow callbacks

A proxy restricted to `/eve/` lets a session start, but the run stalls when its callback can’t reach eve. Preserve both prefixes without rewriting their paths.

## Set the public callback origin

Connection sign-in links and the callback URLs a parent passes to [remote agents](../remote-agents) start from the server's own address, which is `http://localhost:<port>` outside Vercel. Set `WORKFLOW_LOCAL_BASE_URL` to the agent's public origin, such as `https://support.example.com`, when your agent uses either feature:

```bash
WORKFLOW_LOCAL_BASE_URL=https://support.example.com eve start --host 0.0.0.0
```

The Workflow world also delivers its queued work to that origin, so those deliveries pass through your proxy. Forward both [proxy route prefixes](#configure-proxy-routes). With the local world, keep a single process behind that origin; see [Use the local world](./workflow-worlds#use-the-local-world).

For an agent mounted under a path prefix, also set `EVE_PUBLIC_ROUTE_PREFIX`; see [Run workspace members](./self-hosted-operations#run-workspace-members).

## Verify the service

Check the health route after your proxy and authentication configuration are active:

```bash
curl https://your_agent.example.com/eve/v1/health
```

Then connect the development TUI and complete a real turn:

```bash
eve remote connect --url https://your_agent.example.com
```

## Continue configuring production

Use these guides to scale, secure, and observe the deployed agent:

- [Workflow worlds](./workflow-worlds): configure the local, Postgres, or another world
- [Operate a self-hosted agent](./self-hosted-operations): upgrade builds, run replicas and schedules, and troubleshoot
- [Authentication](../auth-and-route-protection): configure the host’s route policy
- [Instrumentation](../../observability/instrumentation): export traces and diagnose runtime failures
- [Sandbox](../../sandbox): select and secure a sandbox provider
