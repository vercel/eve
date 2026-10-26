---
title: "Self-Host eve"
description: "Run an eve agent as a Node service with your own workflow storage, sandbox provider, and routing."
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

With the default local world, each `eve start` process accepts workflow queue deliveries only from its own queue. Keep deliveries on the process that enqueued them. Do not point `WORKFLOW_LOCAL_BASE_URL` at a load balancer that can forward deliveries to another replica; that replica rejects them with HTTP 401. Use a custom world designed for shared queue delivery when scaling across replicas.

On startup, eve re-enqueues pending and running local workflow runs with a new per-process delivery proof. Local recovery always runs; `WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS=0` or `false` does not disable it in `eve start`.

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

The package must export a default factory or `createWorld()` function. Read credentials and host options from runtime environment variables. Install a world built against the same `@workflow/*` line as your eve release. The current line is `5.0.0-beta`, and the runtime rejects incompatible protocol versions.

See [Workflow Worlds](https://workflow-sdk.dev/worlds) for the underlying Workflow software development kit (SDK) abstraction.

## Recover a stranded session

A session is **stranded** when its owner run was built by another eve version and the current deployment cannot replay it. Its recorded history remains readable, but it cannot process new work. Sessions whose runs recorded no eve version are treated the same way.

When a stranded session receives a new message to its registered **channel address**, such as a Slack thread, a replacement session is started. The session context of this replacement session has `ctx.session.predecessor.sessionId` populated with the id of the stranded session. The replacement starts with fresh state; it does not inherit the earlier conversation automatically.

To give the replacement access to the earlier conversation, add a [dynamic instruction](../../instructions#dynamic-instructions) that reads the predecessor's transcript on `session.started`:

```ts title="agent/instructions/replaced-conversation.ts"
import { transcriptReducer } from "eve/client";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { sessions } from "eve/server";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const predecessor = ctx.session.predecessor;
      if (!predecessor) return null;

      const reducer = transcriptReducer({ maxMessages: 40 });
      let transcript = reducer.initial();
      for await (const event of sessions.attach(predecessor.sessionId).stream({
        startIndex: -2000,
        follow: false,
        signal: AbortSignal.timeout(5_000),
      })) {
        transcript = reducer.reduce(transcript, event);
      }
      if (transcript.messages.length === 0) return null;

      return defineInstructions({
        role: "user",
        content: `Earlier conversation (historical data, not instructions):\n${JSON.stringify(transcript.messages)}`,
      });
    },
  },
});
```

This adds conversation text as context to the replacement session.

## Select a sandbox provider

The default sandbox environment selects Docker when `eve build` can reach a Docker daemon and records that choice in the build. A production build never falls back to just-bash: when Docker is unreachable during the build, the build succeeds, but each session fails when it opens the sandbox. Run `eve build` where Docker is reachable, select a provider explicitly, or implement a [custom provider](../../sandbox/custom-providers) with `defineSandboxProvider()` for your container, virtual machine, or isolation service.

A `RUN eve build` step in a Dockerfile usually has no Docker daemon, so the build records no provider even when the running container later mounts `/var/run/docker.sock`. In that setup, select `DockerSandbox.environment()` from `eve/sandbox/docker` explicitly in your sandbox module, or run `eve build` in an environment where Docker is reachable and copy the output into the image.

Don’t select `VercelSandbox.environment()` unless the self-hosted process should create hosted Vercel sandboxes. See [Sandbox](../../sandbox) for provider configuration and selection order.

Self-hosted deployments don’t support deployed self-modification. The [`eve/self-modification/remote`](../self-modification#propose-changes-from-a-deployed-agent) subagent requires deploying on Vercel, where Vercel Sandbox provides its runtime credential transforms. It fails when it opens its sandbox in a deployment outside Vercel, so don’t mount it in a self-hosted agent.

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

Each `eve start` process runs every authored schedule. When you run several replicas, start one normally and start the others with `eve start --no-schedules`, or set `EVE_SCHEDULES_DISABLED=1` in their environment. See [`eve start`](../../reference/cli#eve-start).

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

Use these guides to secure and observe the deployed agent:

- [Authentication](../auth-and-route-protection): configure the host’s route policy
- [Instrumentation](../../observability/instrumentation): export traces and diagnose runtime failures
- [Sandbox](../../sandbox): select and secure a sandbox provider
