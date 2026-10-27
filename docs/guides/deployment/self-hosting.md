---
title: "Self-Host eve"
description: "Run an eve agent as a Node service with your own workflow storage, sandbox provider, and routing."
---

Self-hosting runs eve’s Nitro server as a Node service on infrastructure you operate. You choose where workflows are stored and where sandbox sessions execute.

## Build and start the Node service

```bash
eve build
PORT=3000 eve start --host 0.0.0.0
```

The build writes the Nitro server under `.output/`. `eve start` serves it and accepts `PORT` or `--port`. Your process manager or container platform handles Transport Layer Security (TLS), scaling, restarts, and log collection.

## Configure model access and route auth

Set `AI_GATEWAY_API_KEY` to use a string model ID through the Vercel AI Gateway. To call a provider directly, install its [AI SDK provider package](https://ai-sdk.dev/docs/foundations/providers-and-models), pass its model object in `agent.ts`, and set its API key. See [Agent configuration](../../agent-config#set-the-model) for examples.

Outside Vercel, don’t rely on `vercelOidc()` as the only production authenticator. Instead, configure Basic auth, JSON Web Token (JWT) verification, generic OpenID Connect (OIDC), or a custom verifier. See [Authentication](../auth-and-route-protection).

## Persist workflow state

The default local Workflow world stores run state under `.eve/.workflow-data`. Mount that directory on persistent storage so runs survive process and container replacement.

The default local world accepts queue messages only from its own `eve start` process. Don’t point `WORKFLOW_LOCAL_BASE_URL` at a load balancer, because another replica rejects forwarded messages with HTTP 401. To scale across replicas, use a custom world with a shared queue.

On startup, `eve start` queues pending and running local workflow runs again. `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS=0` or `false` doesn’t disable this recovery.

You can instead select an installed Workflow world package in the root `agent.ts`:

```typescript
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

The package must export a default factory or `createWorld()` function. It reads credentials and host options from runtime environment variables. The world must target the same `@workflow/*` major line as your eve release, currently `5.x`; eve rejects any other line. See [Workflow Worlds](https://workflow-sdk.dev/worlds) for the Workflow software development kit (SDK) abstraction.

## Recover a stranded session

A session is **stranded** when another eve version built its workflow run, so the current deployment cannot replay it. Its history stays readable, but it cannot process new work. A new message to its channel address starts a replacement session, and `ctx.session.predecessor` names the stranded one. See [Stranded sessions](../../concepts/execution-model-and-durability#stranded-sessions) for behavior in each world and how the replacement reads the earlier conversation.

## Select a sandbox provider

The default sandbox environment selects Docker when `eve build` can reach a Docker daemon, and records that choice in the build. A production build never falls back to just-bash. If Docker is unreachable during the build, the build succeeds, but each session fails when it opens the sandbox. To fix this, run `eve build` where Docker is reachable, select a provider explicitly, or implement a [custom provider](../../sandbox/custom-providers) with `defineSandboxProvider()`.

A `RUN eve build` step in a Dockerfile usually has no Docker daemon, so the build records no provider, even if the container later mounts `/var/run/docker.sock`. Select `DockerSandbox.environment()` from `eve/sandbox/docker` in your sandbox module, or build where Docker is reachable and copy the output into the image.

Don’t select `VercelSandbox.environment()` unless the self-hosted process should create hosted Vercel sandboxes. See [Sandbox](../../sandbox) for provider configuration and selection order.

Don’t mount the [`eve/extensions/self-modification/remote`](../self-modification#propose-changes-from-a-deployed-agent) subagent in a self-hosted agent. It needs Vercel Sandbox’s runtime credential transforms, so it fails when it opens its sandbox outside Vercel.

## Configure proxy routes

Forward both runtime route prefixes through your reverse proxy or ingress without rewriting their paths:

- `/eve/` serves health, sessions, streams, channels, tools, and subagents
- `/.well-known/workflow/` receives workflow callbacks

If the proxy forwards only `/eve/`, a session starts but the run stalls because its workflow callback can’t reach eve.

## Run workspace members

An [agent workspace](../../concepts/project-structure#several-root-agents) needs neither Vercel nor a frontend at runtime. Build each member from its own directory, because a root `eve build` produces a Vercel workspace deployment.

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

This Caddy configuration gives each agent its own origin and forwards all paths unchanged. Point the hostnames at your server and run Caddy on the same machine:

```text
support.example.com {
    reverse_proxy 127.0.0.1:3001
}

research.example.com {
    reverse_proxy 127.0.0.1:3002
}
```

Apply the authentication, persistent storage, and sandbox configuration above to each member, and persist each member's own `.eve/.workflow-data` directory.

If agents delegate to one another, configure an explicit [workspace-peer transport](../../subagents#vercel-workspace-peers) with the peer's URL and credentials, because the default transport requires Vercel. Remote agent callbacks must reach a public address. Outside `eve dev`, eve refuses callback hosts that resolve to loopback, private, link-local, or reserved addresses. Callbacks over a private network or `127.0.0.1` fail. See [How remote dispatch and callbacks work](../remote-agents#how-remote-dispatch-and-callbacks-work).

### Add a peer frontend

A frontend under `apps/web/` is a separate service that runs with its framework commands, not `eve start`. A browser client can call an agent origin directly with `useEveAgent({ baseUrl: "https://support.example.com" })`. Configure [CORS](../../channels/eve#cors) and browser credentials for that deployment. Alternatively, mount each agent on the frontend's origin through your reverse proxy.

For path-based mounts, strip the public prefix before forwarding to the agent. Set `EVE_PUBLIC_ROUTE_PREFIX` in that agent's build and runtime environments. Forward its workflow callback routes as well as its eve routes. Keep the browser client, callback URLs, and peer transports consistent with the public mounts.

To have Next.js start the built agent processes and provide the browser-facing proxy routes, use [`eve/next`](../frontend/nextjs#dev-vs-deploy-topology). A self-hosted process manager ignores `eve/vercel` configuration.

## Run schedules

`eve start` runs every authored schedule. On a custom HTTP-only host or preset, run Nitro scheduled tasks or invoke the same work from your scheduler.

When you run several replicas, start one normally and start the others with `eve start --no-schedules`, or set `EVE_SCHEDULES_DISABLED=1` in their environment. See [`eve start`](../../reference/cli#eve-start).

## Verify the service

After your proxy and authentication are active, check the health route:

```bash
curl https://your_agent.example.com/eve/v1/health
```

Then connect the development TUI and complete a real turn:

```bash
eve remote connect --url https://your_agent.example.com
```

## Continue configuring production

- [Authentication](../auth-and-route-protection): configure the host’s route policy
- [Instrumentation](../../observability/instrumentation): export traces and diagnose runtime failures
- [Sandbox](../../sandbox): select and secure a sandbox provider
