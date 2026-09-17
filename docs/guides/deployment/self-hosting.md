---
title: "Self-Host eve"
description: "Run an eve agent as a Node service with your own workflow storage, sandbox backend, and routing."
---

Self-host eve when you operate a Node service, container platform, or reverse proxy. You run eve’s Nitro server and choose the infrastructure that stores workflows and executes sandbox sessions.

## Build and start the Node service

Build the agent, then start the generated server:

```bash
eve build
PORT=3000 eve start --host 0.0.0.0
```

The build writes the Nitro server under `.output/`. `eve start` serves that output and accepts either `PORT` or the `--port` flag.

Run this process under the same process manager or container platform you use for other Node web services. Configure Transport Layer Security (TLS), scaling, restarts, and log collection in that platform.

## Configure model access and route auth

Set `AI_GATEWAY_API_KEY` to use a string model ID through the Vercel AI Gateway from a non-Vercel host. To call a provider directly, install its [AI SDK provider package](https://ai-sdk.dev/docs/foundations/providers-and-models). Then pass its model object in `agent.ts` and set its API key. See [Agent configuration](../../agent-config#set-the-model) for examples.

Don’t rely on `vercelOidc()` as the only production authenticator outside Vercel. Configure Basic auth, JSON Web Token (JWT) verification, generic OpenID Connect (OIDC), or a custom verifier that your host can validate. See [Authentication](../auth-and-route-protection).

## Persist workflow state

The default local Workflow world stores run state under `.eve/.workflow-data`. Mount that directory on persistent storage so runs survive process and container replacement.

You can instead select an installed Workflow world package in the root `agent.ts`:

```typescript
import { defineAgent } from "eve";

export default defineAgent({
  experimental: {
    workflow: {
      world: "@acme/eve-workflow-world",
    },
  },
});
```

The package must export a default factory or `createWorld()` function. Read credentials and host options from runtime environment variables. Install a world built against the same `@workflow/*` line as your eve release. The current line is `5.0.0-beta`, and the runtime rejects incompatible protocol versions.

See [Workflow Worlds](https://workflow-sdk.dev/worlds) for the underlying Workflow software development kit (SDK) abstraction.

## Select a sandbox backend

`defaultBackend()` selects a local sandbox backend in availability order. You can instead select Docker, microsandbox, or a custom `SandboxBackend` adapter for your container, virtual machine, or isolation service.

Don’t select `vercel()` unless the self-hosted process should create hosted Vercel sandboxes. See [Sandbox](../../sandbox) for backend configuration and selection order.

## Configure proxy routes

Forward both runtime route prefixes through your reverse proxy or ingress:

- `/eve/` serves health, sessions, streams, channels, tools, and subagents
- `/.well-known/workflow/` receives workflow callbacks

A proxy restricted to `/eve/` lets a session start, but the run stalls when its callback can’t reach eve. Preserve both prefixes without rewriting their paths.

## Run workspace members

An [agent workspace](../../concepts/project-structure#several-root-agents) does not require Vercel or a frontend at runtime. Build each member from its own directory: root `eve build` produces a Vercel workspace deployment, not a group of self-hosted Node servers.

For a workspace containing `support` and `research`, run these from the workspace root, outside a Vercel build environment:

```bash
(cd agents/support && npx eve build)
(cd agents/research && npx eve build)
```

Start each built agent in a separate terminal, or configure these commands in your process manager:

```bash
(cd agents/support && npx eve start --host 127.0.0.1 --port 3001)
(cd agents/research && npx eve start --host 127.0.0.1 --port 3002)
```

For example, this Caddy configuration gives each agent its own origin and forwards both `/eve/` and `/.well-known/workflow/` without changing their paths. Point the example hostnames at your server and run Caddy on the same machine:

```text
support.example.com {
    reverse_proxy 127.0.0.1:3001
}

research.example.com {
    reverse_proxy 127.0.0.1:3002
}
```

Apply the authentication, persistent storage, and sandbox configuration above to each member. With the default local Workflow world, persist each member's own `.eve/.workflow-data` directory. If agents delegate to one another, configure an explicit [workspace-peer transport](../../subagents#vercel-workspace-peers) with the peer's URL and credentials; the default transport requires Vercel. Ensure callback URLs are reachable from the services that call them.

### Add a peer frontend

A frontend under `apps/web/` is another service managed by your host, not by `eve start`. Build and start it using its framework commands. A browser client can use `useEveAgent({ host: "https://support.example.com" })`; configure [CORS](../../channels/eve#cors) and browser credentials for that deployment. Alternatively, mount each agent on the frontend's origin through your reverse proxy.

For path-based mounts, strip the public prefix before forwarding requests to the agent and set `EVE_PUBLIC_ROUTE_PREFIX` in that agent's build and runtime environments. Forward its workflow callback routes as well as its eve routes. Keep the browser client, callback URLs, and peer transports consistent with the public mounts.

You can instead use [`eve/next`](../frontend/nextjs#dev-vs-deploy-topology) if you want Next.js to start built agent processes and provide the browser-facing proxy routes. That integration is optional; `eve/vercel` configuration is not used by a self-hosted process manager.

## Run schedules

The standard `eve build && eve start` path starts Nitro’s schedule runner. If you adapt the output to a custom HTTP-only host or preset, run Nitro scheduled tasks or invoke the same work from your scheduler.

## Verify the service

Check the health route after your proxy and authentication configuration are active:

```bash
curl https://your_agent.example.com/eve/v1/health
```

Then connect the development TUI and complete a real turn:

```bash
eve dev https://your_agent.example.com
```

## Continue configuring production

Use these guides to secure and observe the deployed agent:

- [Authentication](../auth-and-route-protection): configure the host’s route policy
- [Instrumentation](../../observability/instrumentation): export traces and diagnose runtime failures
- [Sandbox](../../sandbox): select and secure a sandbox backend
