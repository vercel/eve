---
title: "Run Multiple Deployments on Postgres"
description: "Release a new build of a self-hosted eve agent on the Postgres Workflow world while the previous build finishes its in-flight runs."
---

Deployment routing lets several builds of one agent share a single `@workflow/world-postgres` database. Each run executes only on the build that started it, so an in-flight turn finishes on its original code while new sessions start on the new release. Idle sessions move to the new release on their next message.

Deployment routing is experimental. It requires a `@workflow/world-postgres` release that supports `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING`, and `WORKFLOW_POSTGRES_INVOKE` must be unset on every process. You must keep each deployment's processes running until its work ends: the Postgres world does not detect a deployment with no running processes.

Without routing, every process serves one shared deployment, and an upgrade replaces the code that executes existing runs. See [Stranded sessions](../../concepts/execution-model-and-durability#stranded-sessions) for that behavior.

## How deployments are routed

A deployment is a group of processes that run the same build and report the same deployment ID. Every run records the deployment ID of the process that started it. Work for that run, including its steps, replays, hook resumes, subagent sessions, and workflow tool runs, is queued for that deployment and executed only by its processes.

Routing is configured per process, not per database:

| Setting                                      | Deployment ID                         | Jobs the process executes        | Runs recovered at startup |
| -------------------------------------------- | ------------------------------------- | -------------------------------- | ------------------------- |
| `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING` unset | `postgres`                            | `workflow_flows`                 | Runs recorded `postgres`  |
| `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1`     | The value of `WORKFLOW_DEPLOYMENT_ID` | `workflow_flows@<deployment ID>` | Runs recorded with its ID |

The job names assume the default prefix. If you set `WORKFLOW_POSTGRES_JOB_PREFIX`, it replaces `workflow_` in each name.

A process with routing off is the legacy `postgres` deployment. Runs created before you enabled routing are recorded as `postgres`, so they keep executing on processes with routing off. Processes in either mode can send work to the other: a process with routing on can wake a `postgres` run, and a `postgres` process can wake a run on a routed deployment.

The jobs queued for a deployment wait until one of its processes runs. Nothing fails or times out when a deployment has no processes, so stopping a deployment too early leaves its sessions unresponsive rather than producing an error.

## Choose deployment IDs

Give each build its own deployment ID, and give every replica of that build the same ID. Treat an app-only change, such as new instructions, tools, or prompts, the same as an eve upgrade: it needs a new deployment ID even when the eve version is unchanged.

`eve build` derives an ID from the build output, in the form `eve_` followed by 32 hexadecimal characters, and sets `WORKFLOW_DEPLOYMENT_ID` to it when the server starts. Build once and copy the same `.output/` to every replica. Building the same commit again, or on another machine, can produce a different ID.

To control the ID yourself, set `WORKFLOW_DEPLOYMENT_ID` in the runtime environment. An explicit value takes precedence over the derived one. The ID must be 1–64 letters, digits, `_`, `.`, or `-`, and cannot be `postgres` or `latest`.

```bash
WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1 \
WORKFLOW_DEPLOYMENT_ID=support-2026-10-20 \
eve start --host 0.0.0.0
```

Never reuse an ID for a different build. Processes that share an ID take each other's jobs, so a reused ID runs old turns on new code, and eve skips its version check when routing is on.

Setting `WORKFLOW_DEPLOYMENT_ID` alone does not enable routing. With `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING` unset, the process ignores the variable and runs as `postgres`.

## Enable routing on an existing database

Enable routing in two releases. The first upgrades the Postgres world without changing how runs are routed; the second adds a routed deployment beside the legacy one.

1. **Upgrade `@workflow/world-postgres` on every process, with routing off.** Keep the eve version and your app code unchanged in this release, so existing sessions keep running on the same code. Earlier `@workflow/world-postgres` releases ignore the deployment a job is addressed to and recover every active run at startup, so they would execute routed runs on their own code. Confirm that no process runs an earlier release before continuing.
2. **Build the next release and start it with routing on.** Set `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1` on its processes. This is deployment B.
3. **Move all public traffic to B.** Route every channel, client, and webhook request under `/eve/` to B's processes. Run authored schedules only on B.
4. **Keep the legacy processes running as a drainer.** Remove them from your load balancer and restart them with `eve start --no-schedules`. Leave `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING` unset on them.
5. **Retire the legacy deployment** once its runs end. See [Retire a deployment](#retire-a-deployment).

A drainer still executes work without public traffic. Each Postgres world process delivers its jobs to its own server over loopback, at `http://localhost:$PORT`. If you set `WORKFLOW_LOCAL_BASE_URL`, point it at the same process, not at a load balancer that can reach another deployment.

## Release a new build

Once routing is on, use the same sequence for every release:

1. Build the release once and start its processes with `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1`.
2. Move all public traffic and schedules to the new deployment.
3. Restart the previous deployment's processes with `eve start --no-schedules`, outside the load balancer, and keep their environment, including the same `WORKFLOW_DEPLOYMENT_ID` when you set one explicitly.
4. Retire the previous deployment once its runs end.

Restarting or adding replicas of an unchanged build does not need a new deployment. Start the replacement processes from the same `.output/` with the same environment.

Several draining deployments can run at once. Each one polls Postgres for its jobs even when idle, so size the drainers' `WORKFLOW_POSTGRES_WORKER_CONCURRENCY`, `WORKFLOW_POSTGRES_MAX_POOL_SIZE`, and `WORKFLOW_POSTGRES_POLL_INTERVAL_MS` for their remaining work. See the [`@workflow/world-postgres` configuration](https://workflow-sdk.dev/worlds/postgres).

## What happens to sessions during a release

In this section, A is the previous deployment and B is the deployment that receives public traffic.

- **New sessions** start on B, and all of their work runs on B.
- **An idle session owned by A** moves to B on its next message. B accepts the message, A hands the session off with its conversation and state, and B runs the turn. The session keeps its ID, stream, and channel addresses. See [Sessions, turns, and steps](../../concepts/execution-model-and-durability#sessions-turns-and-steps) for what a handoff carries.
- **A busy session owned by A** stays on A. A running turn, pending human input or authorization, queued messages, and active tasks or subagents keep the session on A. A later message can move it once that work settles.
- **Subagent sessions and workflow tool runs started on A** finish on A. Handoff does not move them.
- **A refused handoff** leaves the session on A, which processes the message. This happens when A's eve release does not support handoff, or when B cannot read A's checkpoint. A writes a `session handoff failed` warning to its logs.

A session that moved to B still depends on A. Its first run, which owns the session's public stream, stays on A until the session ends, and A must execute it to complete the session and close the stream.

A session moves to whichever deployment accepted its message, not to the newest one. If A still receives some public traffic, sessions owned by B can move back to A. Remove a drainer from every public route, not only from schedules.

## Retire a deployment

A deployment can stop once nothing can send new work to it and none of its runs are active. Before stopping it:

1. Confirm that the deployment receives no public traffic or schedules, and that no other system starts runs on it.
2. Confirm that it has no pending or running runs:

```sql
SELECT count(*)
FROM workflow.workflow_runs
WHERE deployment_id = 'your_deployment_id_here'
  AND status IN ('pending', 'running');
```

For the legacy deployment, use `deployment_id = 'postgres'`.

To see which deployments still have active work:

```sql
SELECT deployment_id, count(*)
FROM workflow.workflow_runs
WHERE status IN ('pending', 'running')
GROUP BY deployment_id;
```

The count includes every session's first run, so it stays above zero while any session that started on the deployment is open, even after the session moved elsewhere. It also includes subagent sessions, workflow tool runs, and session timeout timers.

Sessions end when they complete, are reset, or reach their [`sessionTimeoutMs`](../../agent-config#runtime-limits), 30 days by default. Each handoff to another deployment restarts that timeout, and a session with `sessionTimeoutMs: false` never times out, so an active session can keep its first deployment in use indefinitely. Set a finite `sessionTimeoutMs` to bound how long draining deployments must run.

If you stop a deployment that still has active runs, nothing reports the failure. Messages to its sessions are accepted and wait for work that never runs, and sessions that moved elsewhere cannot complete their streams.

## Limitations

- **No invocation delivery.** With `WORKFLOW_POSTGRES_INVOKE=1`, a process sends hook inputs only to its own deployment's runs. A message to a session owned by another deployment fails with a `409` error, so idle sessions cannot move to the new release.
- **No availability check.** A deployment ID without running processes accepts work indefinitely. eve does not replace sessions whose deployment is gone.
- **No bounded drain.** A session's first run keeps its original deployment in use until the session ends; see [Retire a deployment](#retire-a-deployment).
- **One build per ID.** The Postgres world cannot tell whether every process with an ID runs the same build. Your release process must guarantee it.
- **No rollback by ID.** To roll back, move public traffic to the earlier deployment while it is still running. Idle sessions then hand off to it, if its eve release accepts checkpoints from the newer release; otherwise they stay where they are.

## Troubleshooting

| Symptom                                                                | Check                                                                                                                   | Next action                                                                                           |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A session accepts messages but never replies                           | Look up the session's runs in `workflow.workflow_runs` and compare their `deployment_id` with your running deployments. | Start that deployment's build with its original environment. Its queued jobs run when it starts.      |
| A process fails at startup with `requires WORKFLOW_DEPLOYMENT_ID`      | `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1` is set, but the process has no deployment ID.                                  | Start the server with `eve start` from an `eve build` output, or set `WORKFLOW_DEPLOYMENT_ID`.        |
| A process fails at startup with `Invalid Postgres World deployment id` | The configured ID is `postgres`, `latest`, too long, or contains other characters.                                      | Choose a different ID, or unset routing to run as the legacy `postgres` deployment.                   |
| Messages to older sessions fail with a `409` error                     | Check whether `WORKFLOW_POSTGRES_INVOKE=1` is set on any process.                                                       | Unset `WORKFLOW_POSTGRES_INVOKE` on every process and restart them.                                   |
| Old sessions stay on the previous deployment                           | Search the previous deployment's logs for `session handoff failed`.                                                     | Keep the previous deployment running. Busy sessions move after their work settles; refused ones stay. |
| Runs on the new deployment record `postgres`                           | Check that `WORKFLOW_POSTGRES_DEPLOYMENT_ROUTING=1` is set in the runtime environment of every new process.             | Restart those processes with routing on. Runs already recorded as `postgres` need a legacy drainer.   |
| Sessions move back to the previous deployment                          | Check whether any public route or channel webhook still reaches the previous deployment.                                | Remove the previous deployment from every public route.                                               |

## Related

- [Self-host eve](./self-hosting): build, start, and proxy a self-hosted agent
- [Execution model and durability](../../concepts/execution-model-and-durability): handoff and stranded sessions
- [Workflow world](../../agent-config#workflow-world): select `@workflow/world-postgres` in `agent.ts`
