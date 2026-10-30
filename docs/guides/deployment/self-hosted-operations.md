---
title: "Operate a Self-Hosted Agent"
description: "Upgrade, scale, and troubleshoot an eve agent that runs on your own infrastructure."
---

Use this guide after your agent runs with [`eve start`](./self-hosting). It covers upgrades, replicas, schedules, workspace members, run data, and common failures.

## Upgrade a self-hosted agent

A self-hosted Workflow world serves one eve version at a time. Deploying a new build of your agent on the same eve release keeps existing sessions running. Upgrading eve strands sessions started by the previous version: their recorded history remains readable, but they cannot resume. See [Recover a stranded session](#recover-a-stranded-session) for how a new channel message starts a replacement.

To deploy a new build:

1. Stop the processes running the previous build.
2. With the Postgres world, run `bootstrap` if the build upgrades `@workflow/world-postgres`; see [Use the Postgres world](./workflow-worlds#use-the-postgres-world).
3. Start the new build with `eve start`.

When the eve version is unchanged, the new build resumes runs that were active when the previous processes stopped.

### Recover a stranded session

A session is **stranded** when another eve version built its workflow run, so the current deployment cannot replay it. Its history stays readable, but it cannot process new work. A new message to its channel address starts a replacement session, and `ctx.session.predecessor` names the stranded one. See [Stranded sessions](../../concepts/execution-model-and-durability#stranded-sessions) for behavior in each world and how the replacement reads the earlier conversation.

## Run replicas

Use the [Postgres world](./workflow-worlds#use-the-postgres-world) to serve an agent from several `eve start` processes. Every process connected to the database runs queued work, so any replica can continue any session. The local world serves one process.

Configure each replica the same way, with two differences:

- Run schedules on one replica only; see [Run schedules](#run-schedules).
- Give every replica access to the same sandboxes. A session records its sandbox, and the next replica to run the session resumes it. A Docker sandbox lives on the Docker daemon of the host that created it. A replica that can't find it starts a fresh sandbox without the earlier files if its own daemon has the build's sandbox image, and fails with `SandboxTemplateNotProvisionedError` otherwise. For replicas on several hosts, use a provider every replica can reach, such as [Vercel Sandbox](../../sandbox/vercel) or a [custom provider](../../sandbox/custom-providers).

## Run schedules

`eve start` runs every authored schedule. On a custom HTTP-only host or preset, run Nitro scheduled tasks or invoke the same work from your scheduler.

When you run several replicas, start one normally and start the others with `eve start --no-schedules`, or set `EVE_SCHEDULES_DISABLED=1` in their environment. See [`eve start`](../../reference/cli#eve-start).

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

Apply the [authentication, Workflow world, and sandbox configuration](./self-hosting) to each member. With the default local Workflow world, persist each member's own `.eve/.workflow-data` directory.

If agents delegate to one another, configure an explicit [workspace-peer transport](../../subagents#vercel-workspace-peers) with the peer's URL and credentials, because the default transport requires Vercel. Remote agent callbacks must reach a public address. Outside `eve dev`, eve refuses callback hosts that are, or resolve to, loopback, private, link-local, or reserved addresses. So callbacks between services over a private network or `127.0.0.1` don't work. See [How remote dispatch and callbacks work](../remote-agents#how-remote-dispatch-and-callbacks-work) and [Set the public callback origin](./self-hosting#set-the-public-callback-origin).

### Add a peer frontend

A frontend under `apps/web/` is a separate service that runs with its framework commands, not `eve start`. A browser client can call an agent origin directly with `useEveAgent({ baseUrl: "https://support.example.com" })`. Configure [CORS](../../channels/eve#cors) and browser credentials for that deployment. Alternatively, mount each agent on the frontend's origin through your reverse proxy.

For path-based mounts, strip the public prefix before forwarding to the agent. Set `EVE_PUBLIC_ROUTE_PREFIX` in that agent's build and runtime environments. Forward its workflow callback routes as well as its eve routes. Keep the browser client, callback URLs, and peer transports consistent with the public mounts.

To have Next.js start the built agent processes and provide the browser-facing proxy routes, use [`eve/next`](../frontend/nextjs#self-host). A self-hosted process manager ignores `eve/vercel` configuration.

## Manage run data

The Workflow world holds every session's history. Back it up with the rest of your application data:

- **Local world:** back up the `.eve/.workflow-data` directory.
- **Postgres world:** back up the database. The Postgres world keeps the records of finished runs until you delete them.

eve can ask the world to delete a run's inputs, outputs, and stream contents when the run ends. See [Run data retention](../../agent-config#run-data-retention) for the default policy and the override.

## Troubleshoot a self-hosted agent

| Symptom                                                                         | Check                                                                                                                                | Next action                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Sandbox tools fail with `DefaultSandbox has no sandbox provider for this build` | Whether `eve build` could reach a Docker daemon, for example inside a Dockerfile `RUN` step                                          | Rebuild where Docker is reachable, or [select a provider explicitly](./self-hosting#build-inside-a-container-image)          |
| Workflow deliveries fail with HTTP 401 with the local world                     | Whether `WORKFLOW_LOCAL_BASE_URL` reaches a load balancer in front of several processes                                              | Serve the agent from one process, or use the [Postgres world](./workflow-worlds#use-the-postgres-world) for replicas         |
| Sign-in links or remote agent callbacks point at `localhost`                    | Whether `WORKFLOW_LOCAL_BASE_URL` is set                                                                                             | [Set the public callback origin](./self-hosting#set-the-public-callback-origin)                                              |
| A session starts but never responds behind a proxy                              | With `WORKFLOW_LOCAL_BASE_URL` pointing at the proxy, whether the proxy forwards `/.well-known/workflow/` without rewriting the path | Forward both [proxy route prefixes](./self-hosting#configure-proxy-routes)                                                   |
| Requests return `409` with `code: "session_stranded"` after an upgrade          | The eve version in the response                                                                                                      | End the session, or send a new message to its channel address; see [Recover a stranded session](#recover-a-stranded-session) |
| Schedules run more than once                                                    | How many replicas run without `--no-schedules`                                                                                       | [Run schedules](#run-schedules) on one replica                                                                               |
