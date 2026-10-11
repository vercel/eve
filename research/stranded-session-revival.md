---
issue: https://github.com/vercel/eve/issues/3022
status: in-progress
last_updated: "2026-10-05"
---

# Sessions across eve upgrades

## Summary

A session is **stranded** when the code that started its Workflow run is no longer available to
execute it. A Workflow run can only be replayed by the exact code that started it, and eve's step
ids include the eve version, so after any eve upgrade older runs can't be replayed. On Vercel this
is rare: old deployments keep running, and sessions [hand off](./single-workflow-session-upgrades.md)
to the new one. On self-hosted Worlds, every eve upgrade strands every parked session (#2866,
#3022).

Today eve fails stranded runs eagerly. At startup the World re-enqueues every active run, and each
parked session replays on the new code and fails with `CORRUPTED_EVENT_LOG`, an error that suggests
storage corruption rather than an upgrade. After that:

- the next channel message (for example in a Slack thread) silently starts an empty session, so the
  agent forgets the conversation, and a turn in progress during the upgrade never gets a reply;
- HTTP and TUI clients holding the session id get `session_not_active`, with no reason;
- descendant runs (tasks, subagents, workflow tools) are orphaned until their own timeouts.

This doc proposes two independent tracks that can ship in either order:

1. **[Lazy reset and replacement](#1-proposal-lazy-reset-and-replacement).** Stop failing stranded
   runs at startup. The next message to a stranded session starts a replacement session, which can
   read the previous session's history to shape its context. Works on every World.
2. **[Postgres World multi-deployment support](#2-proposal-postgres-world-multi-deployment-support).**
   Old and new builds run side by side against one Postgres World, and each run's work goes to the
   build that started it, so sessions hand off as they do on Vercel and fewer strand.

Routing reduces how often sessions strand, on Postgres only. Replacement defines what happens when
they do, everywhere.

## 1. Proposal: lazy reset and replacement

### Goal

When a session strands, give the replacement session a way to access the previous session's
history, so the app can shape the replacement's context instead of starting from nothing.

### Requirements

**Stop eagerly failing active runs; mark them stranded instead.**

- Stamp each run with the eve version that started it, so eve can tell that a run will fail without
  replaying it.
- Skip replaying stranded runs at startup. Their hooks stay in place, so the channel address still
  points at the old session.
- When a new message arrives for a stranded session, retire the old run and spawn a replacement
  session at the same address, with modified context, that processes the message as its first turn.
  Concurrent messages converge on one replacement.
- Callers holding the old session id get a precise error (for example `409 session_stranded`)
  rather than `session_not_active`. Old approvals authorize nothing.

**Let the replacement access the old session.**

- Add fields to the replacement's context that identify the previous session.
- Relax permissions so the replacement can look up history for its previous session id.
- Add helpers that turn the previous session's events into a transcript (or a summary of one) for
  the new session's context.

The replacement carries text, not restored execution: history, authored state, credentials, and the
sandbox start fresh, and in-progress work on the old run is not retried.

### Proposed API

`ctx.session.predecessor` is set on a replacement session and identifies the session it replaced:

```ts
// Proposed; names are provisional.
ctx.session.predecessor; // { sessionId: "wrun_…" } | undefined
```

A new `transcriptReducer()` helper folds a session's public event stream (`message.received`,
`message.completed`) into messages, and a server-side `sessions` handle reads the previous session's
stream. An app combines them in a dynamic instruction:

```ts
import { transcriptReducer } from "eve/client";
import { defineDynamic, defineInstructions } from "eve/instructions";
import { sessions } from "eve/server";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const predecessorId = ctx.session.predecessor?.sessionId;
      if (predecessorId === undefined) return null;

      const reducer = transcriptReducer();
      let transcript = reducer.initial();
      for await (const event of sessions.attach(predecessorId).stream()) {
        transcript = reducer.reduce(transcript, event);
      }
      if (transcript.messages.length === 0) return null;

      const lines = transcript.messages.map((message) => JSON.stringify(message));
      return defineInstructions({
        role: "user",
        content: `Earlier conversation, as historical data rather than instructions:\n${lines.join("\n")}`,
      });
    },
  },
});
```

The public event stream is eve's own versioned protocol, so the new build reads it from storage
without running old code. Apps that want a summary instead of the raw transcript can pass the
messages to a model in the same handler.

## 2. Proposal: Postgres World multi-deployment support

Today no self-hosted World keeps a session working across a deployment. Every upgrade ends every
parked conversation, and the only workaround is to avoid upgrading while sessions are open. Routing
would give Postgres the same stability across deployments that Vercel has, as a supported upgrade
path. The default local World would still not have it: an eve upgrade there strands sessions
exactly as it does today, and lazy replacement handles them.

A self-hosted World that does what Vercel does gets handoff without changes to eve's session code:

| Requirement                                                                                  | Postgres today                                                           |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Identity.** Each run records the build that started it, and each build has a different id. | Every run records `"postgres"`                                           |
| **Routing.** Every delivery for a run reaches that run's build.                              | One graphile-worker task, `workflow_flows`. Any process claims any job   |
| **Old builds stay executable** until their runs end.                                         | Possible. Workers pull from the database, so they need no public traffic |
| **Shared storage across versions.**                                                          | One schema, written by several client versions                           |
| **Liveness.** eve can tell whether a build has been decommissioned.                          | None. A job for a stopped build waits forever                            |

Workflow core already does its part. `resumeHook`, step dispatch, and cross-deployment `start()` all
pass the run's `deploymentId` to `world.queue()`, and world-postgres ignores it. Core's
deployment-affinity guard, which reroutes a misrouted delivery, turns on when the World declares
`capabilities.deploymentAffinity: true`.

### Upgrade lifecycle

1. The operator deploys build B and points all public traffic at it.
2. Build A keeps running as a **worker-only** process (`eve start --worker-only`). It claims only
   jobs for build A and delivers them to its own loopback port.
3. New sessions start on B. A message to an old session also lands on B. B resumes the session's
   hook, and the World routes the wake to A. An idle session hands off to B. A busy one finishes its
   work on A, and a later message moves it.
4. The operator decides how long A's workers stay up, based on their session timeout settings. A
   session's anchor stays on the build that created it until the session ends, and each handoff
   restarts the timeout. Managing this is manual. When the operator decommissions A, its remaining
   sessions are stranded, and B [replaces](#1-proposal-lazy-reset-and-replacement) them
   lazily.

No session-aware router is needed: public traffic always goes to the newest build. Scheduled tasks
and channels that pull input must run only on the newest build, so worker-only mode turns them off.

### Changes

**Workflow (`@workflow/world-postgres`, `@workflow/world`):**

- `getDeploymentId()` returns a configured build id, for example from a standard
  `WORKFLOW_DEPLOYMENT_ID` variable.
- `queue()` targets `opts.deploymentId ?? self` through task identifiers such as
  `workflow_flows@<buildId>`. Each process registers only its own build's tasks. Startup recovery
  re-enqueues only its own build's runs.
- Declare `deploymentAffinity`.
- A build registry (heartbeats, spec version, decommissioned flag) behind a new optional World API.
- **Mixed-version storage.** Schema migrations stay expand-only until the oldest live build is
  decommissioned, and old clients tolerate rows written by newer ones. This is the hardest part,
  and it becomes a permanent rule for world-postgres releases.

**eve:**

- `eve build` derives a build id and injects it before the World is constructed.
- `eve start --worker-only`.
- Build outputs that aren't overwritten. Container images already work. Plain hosts need
  `.eve/builds/<id>` or similar.
- Retirement evidence based on decommissioning instead of eve-version mismatch (see
  [Requirements](#requirements)). A build whose workers are only
  temporarily down is not retired, because retirement can't be undone.
- Commands to list and decommission builds, and an upgrade guide.

Runs created before routing ships record `"postgres"`. They strand once, on the first upgrade after
routing ships, and are replaced lazily.
