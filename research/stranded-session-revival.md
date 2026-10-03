---
issue: https://github.com/vercel/eve/issues/3022
status: in-progress
last_updated: "2026-09-30"
---

# Sessions across eve upgrades

## Summary

A session is **stranded** when the code that started its Workflow run is no longer available to
execute it. On Vercel this is rare: old deployments keep running, and sessions hand off to the new
one. On self-hosted Worlds, every eve upgrade strands every parked session (#2866, #3022).

This doc covers three proposals. Each one stands on its own, and they can ship in any order:

| Proposal                                                                                         | What it does                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [1. Deployment routing for self-hosted Postgres](#1-deployment-routing-for-self-hosted-postgres) | Old and new builds run side by side against one Postgres World, and each run's work goes to the build that started it. Sessions hand off as they do on Vercel.                                           |
| [2. Reset stranded sessions](#2-reset-stranded-sessions)                                         | eve detects a stranded session before delivering to it. A channel message ends it cleanly and starts a fresh session that gets the old transcript as context. A send by session id gets a precise error. |
| [3. Revive stranded sessions](#3-revive-stranded-sessions)                                       | Starts a new session on the new code, seeded with the stranded session's history, so the conversation continues.                                                                                         |

Routing gives self-hosted eve a way to keep sessions working across deployments, which it doesn't
have today. It covers Postgres only. The default local World still has no such path, and supporting
it is [deferred](#deferred-local-world). Reset defines what happens when a session strands anyway, on
every World. Revive goes further than reset: it carries the old session's full state, not just its transcript.

## Status quo

**Replay needs the original code.** A Workflow run can only be replayed by the exact code that
started it. eve's step ids include the eve version, so after any eve upgrade, older runs can't be
replayed. Authored step ids are unversioned, so an app release without an eve upgrade replays
cleanly.

**Vercel hands sessions off.** Ingress stamps each delivery with the deployment that accepted it.
When a delivery from a newer deployment reaches an idle session, the old owner, still running on its
old deployment, checkpoints itself and starts a successor on the new deployment
([handoff](./single-workflow-session-upgrades.md)). The session id and stream don't change. The
original run parks as the **anchor** until the session ends, keeping the stream open. This works
only because Vercel keeps old deployments running and routes each run to its own deployment.

**Sessions end on a timeout.** A session ends when `sessionTimeoutMs` has passed since it was
created or last handed off. The default is 30 days, and `false` turns the timeout off. Ordinary
messages don't extend it. At the deadline the session completes and releases its continuation
aliases. A later post in that Slack thread starts a fresh session with no memory of the old one.

**Self-hosted Worlds can't hand off.** The World is chosen when the app is built
(`experimental.workflow.world`, otherwise the local World), and `eve start` runs that one build.
world-local and world-postgres both have a single queue target and a fixed deployment id, so
neither routes runs by deployment. When an operator upgrades eve:

- **Startup.** The World re-enqueues every active run. Each parked session replays on the new code
  and fails with `CORRUPTED_EVENT_LOG`, an error that suggests storage corruption rather than an
  upgrade.
- **Slack user (and any channel alias).** The next message silently starts an empty session, so the
  bot forgets the conversation. A turn that was in progress during the upgrade never gets a reply.
- **HTTP and TUI clients that hold a session id** get `session_not_active`, with no reason.
- **Descendant runs** (tasks, subagents, workflow tools) are orphaned until their own timeouts.

`eve dev` has the same problem across eve upgrades, because every build generation runs the
installed eve.

## Recommendation

Do proposals 1 and 2:

- **[Deployment routing for self-hosted Postgres](#1-deployment-routing-for-self-hosted-postgres)**,
  so that self-hosted eve has a story for running several deployments, on Postgres. Today it has
  none.
- **[Reset stranded sessions](#2-reset-stranded-sessions)**, with
  [carried context](#carrying-context-into-the-new-session), so that when sessions do strand, the
  fallback is better: users keep the conversation's context, callers get precise errors, operators
  get accurate logs, and descendant runs are cleaned up. This covers every World, including the
  local World, where routing is deferred.

Hold off on [revive](#3-revive-stranded-sessions). Routing plus reset with carried context covers
most of its benefit without its API surface and lifecycle quirks. Revisit it if users still need
full-fidelity recovery after both ship.

## 1. Deployment routing for self-hosted Postgres

Today no self-hosted World keeps a session working across a deployment. Every upgrade ends every
parked conversation, and the only workaround is to avoid upgrading while sessions are open. Routing
would give Postgres the same stability across deployments that Vercel has, as a supported upgrade
path. The default local World would still not have it: an eve upgrade there strands sessions
exactly as it does today, and reset handles them (see [Deferred: local World](#deferred-local-world)).

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
   sessions are stranded, and B [resets](#2-reset-stranded-sessions) them.

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
- Stranded detection based on decommissioning instead of eve-version mismatch. A build that is only
  temporarily unreachable is not stranded, because reset can't be undone.
- Commands to list and decommission builds, and an upgrade guide.

Runs created before routing ships record `"postgres"`. They strand once, on the first upgrade after
routing ships, and get reset.

## 2. Reset stranded sessions

Some sessions strand even with routing: on the local World and single-build setups, on Postgres when
a build is decommissioned, and on every World when the Workflow spec floor moves. Reset makes eve
check for this before delivering a message. It doesn't let replay fail. It ends the stranded session
through the existing `reset` operation, which the docs already describe as terminally retiring a
session.

### What users see

| Who                                     | Today                                                              | With reset                                                                                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack user (any channel alias)          | The bot answers with no memory of the thread                       | Same answer with no memory, unless eve carries the old transcript into the new session (see [Carrying context](#carrying-context-into-the-new-session))               |
| HTTP or TUI client holding a session id | `session_not_active`, no reason                                    | `409 session_stranded` saying the session ended because of an upgrade, and that the next step is to start a new session. `Session.send` throws `SessionStrandedError` |
| Operator                                | Every parked session fails at startup with `CORRUPTED_EVENT_LOG`   | No failed runs. One warning per reset naming the session and both eve versions                                                                                        |
| Authored hooks                          | The old session fails. `session.started` fires for the new session | The old session ends without running its code, so its terminal hooks don't fire. `session.started` fires for the new session                                          |
| Descendant runs                         | Orphaned until their own timeouts                                  | Cancelled                                                                                                                                                             |

By default, nothing changes for chat users: the conversation is lost either way, just as when a
session times out. What improves is that the failure is accurate. Operators get a log line that names the cause
instead of an error that looks like storage corruption. Clients that hold a session id learn why
the session ended and what to do. Stray descendant runs no longer keep running.

### Mechanism

eve looks up the owner before committing a delivery, so a message is never committed to a run that
can't execute it:

- **Channel alias.** eve cancels the stranded run and its descendants, waits for the hooks to be
  released, and starts a new session that claims the alias. The incoming message becomes that
  session's first turn. Concurrent messages to the same address produce one new session.
- **Session id.** Refused, because a silent reset would leave the caller holding a dead id.
- **Explicit `reset` and `clear`** work on stranded sessions. A stranded session can't clear in
  place, so `clear` resets it instead.
- **Startup** skips stranded runs instead of replaying them.

### Carrying context into the new session

A reset doesn't have to start from nothing. Before cancelling the stranded run, eve can read the
conversation so far and give it to the new session as **context**, not as inherited history. This
happens inside eve, so every channel gets it without per-channel logic.

**Where the transcript comes from.** The stranded session's public event stream already records
the conversation: `message.received` for user messages and `message.completed` for assistant
replies. That stream is eve's own versioned protocol, which clients already read across eve
versions. The new build reads it from storage without running the old code. Revive instead reads
Workflow step inputs, which are an internal detail. So the stream is the more stable source, and a
`DURABLE_SESSION_VERSION` bump doesn't affect it. eve reads the stream before cancelling the run,
so zero-retention runs don't lose it first.

**How it reaches the model.** eve builds a bounded transcript of user and assistant text from the
tail of the stream, compacting it with the model if it's long. It injects the transcript into the
new session's first turn, labeled as the conversation before an upgrade. This is similar to what
Slack's `threadContext` does with thread messages. Everything else about the new session is fresh:
history starts with this turn, and state, limits, usage, and the sandbox start over. Nothing from
the old session can act on its own. A pending approval in the transcript is just text, so the model
has to ask again.

**What the user sees.** The bot answers with the conversation in mind. If the new session carries
a link to the stranded one (see [Open questions](#open-questions)), the channel can also tell the
user what happened.

**Compared with revive.**

|                           | Reset with carried context                           | Revive                                                                        |
| ------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| What the new session gets | A transcript, as context in the first turn           | The old history, state, limits, and usage, as its own                         |
| Source                    | Public event stream (eve protocol)                   | Workflow step inputs (internal)                                               |
| Tool calls and results    | Not carried, apart from what the replies mention     | Carried                                                                       |
| Session lifecycle         | Ordinary new session                                 | Continuation: `session.revived`, `revivedFrom`, `session.started` fires again |
| New public API            | Possibly an opt-out, and the link to the old session | Policy, command, route, event, field, error                                   |

The transcript loses information. The model doesn't see tool results or authored state, so it may
need to redo lookups or ask again. In exchange, it adds almost no API, and it works the same on
every channel and every World. For most chat agents, this may close most of the gap between reset
and revive.

Channels can still add their own context on top. For example, Slack's `threadContext` can include
thread messages the bot never received.

### Stranding reasons

The stranding `reason` is `deployment-unavailable` or `world-spec-incompatible`. Without routing,
`deployment-unavailable` means the eve version differs. With routing, it means the owner's build has
been decommissioned.

### Tradeoffs

- **Reset can't be undone.** A session that has been reset can't be resumed by restoring its
  deployment or rolling back eve. We accept this so that stranded sessions recover without anyone
  stepping in. To keep a rollback path, pin eve before upgrading, or with routing, keep the old
  build running.
- One extra lookup per delivery: `runs.get` on local and Postgres, `hooks.getByToken` on Vercel.
- A stranded run that never gets another message stays `running`, because its timeout runs on the
  old code.

## 3. Revive stranded sessions

Revive takes the stranded session's history and passes it into the **new** code, which starts a new
session with that history. The old run never executes again. The new code reads the old run's stored
records and continues the conversation from them.

### Mechanism

1. **Read the checkpoint.** Every session step receives the full session state as its input, and
   the World stores step inputs. The new build reads the latest one from the stranded run:
   history, `defineState` and extension state, limits, usage, and initiator context. It checks
   `$eve.session_version`, a new run attribute, to confirm it can read that format. If it can't,
   revive falls back to reset.
2. **Cancel the stranded run** and its descendants, and wait for its hooks to be released.
3. **Start a new session** seeded with the checkpoint. It claims the channel aliases, so the Slack
   thread maps to it. The current build's instructions, model, and tools apply to the old history,
   just as they do after a handoff.
4. **Emit `session.revived`** as the new session's first event. It carries the previous session id,
   the previous eve version, and the ids of requests that were interrupted.
5. **Run the incoming message** as the first turn.

The session id changes, because the old run's hooks can only be freed by cancelling it, and a
cancelled run's stream is closed.

Revive happens automatically on channel deliveries when the agent opts in with
`sessions: { stranded: "revive" }`. Callers that hold a session id get the same 409 as with reset,
marked `revivable`. They call `POST /sessions/:id/revive` (or `/revive` in the TUI) and switch to
the returned id.

### What users see

A Slack user gets a reply that remembers the conversation. The channel can use `session.revived` or
`ctx.session.revivedFrom` to post something like "I was upgraded. Here's where we left off." For
authored code it's a new session: `session.started` fires again, and once-per-conversation side
effects such as a welcome message need a `revivedFrom` guard. The old session's terminal hooks never
fire.

### Pending work is lost

A checkpoint is the session's last settled state. Anything in progress at that point belonged to
the stranded run and can't be carried forward:

- **An in-progress turn.** If the upgrade interrupted a turn, its partial work after the last
  checkpoint is gone. A tool call may already have had side effects, but its result was never
  recorded. The model sees an interruption record and may call the tool again.
- **Pending approvals and questions.** The Slack buttons or prompts are still visible, but
  answering them does nothing: their ids are listed in `session.revived`, and late answers authorize
  nothing. The model learns the request was interrupted and has to ask again. This is deliberate:
  an approval granted to the old run never authorizes anything in the new session.
- **Tasks, subagents, and workflow tools.** These are cancelled, and their results are lost. The
  model sees an interruption record and decides whether to start them again.
- **Connection authorizations.** Tokens are not carried over, so users re-authorize.
- **The sandbox.** It belongs to the stranded session, so files and processes in it are gone.
- **Messages accepted after the last checkpoint.** These are lost until a planned follow-up
  redelivers them.

So revive is most useful for sessions that were idle when the upgrade happened, which is the usual
case for long chat threads. The more a session had in progress, the closer revive gets to a reset.

### Tradeoffs

- **For:** it recovers the conversation with full fidelity: tool results, authored state, limits,
  and usage, not just a transcript. It tells the user what happened, and the Slack thread keeps
  working. On the local World and single-build setups, it's the only way to keep the full
  conversation.
- **Against:**
  - **API surface:** a policy value, a command, an HTTP route, an event, `revivedFrom`, and a
    revive error.
  - **Lifecycle quirks** that authors must handle: a new id, `session.started` firing again, and
    terminal hooks that never fire.
  - **Coupling to Workflow internals:** it relies on step inputs being kept and holding the full
    state. A `DURABLE_SESSION_VERSION` bump makes older sessions impossible to revive.
  - **A third migration mechanism**, next to handoff and legacy import.
  - **Fewer users** once routing ships, and once reset carries context.

## Deferred: local World

Several processes can't share a local data directory: the caches are in-process, the queue lives in
memory, and every process re-enqueues every run on startup. Separate directories don't work either,
because handoff needs shared storage. Supporting several builds would take a supervisor that owns the
World and routes each delivery to a child process for that build, each with its own copy of eve.
The supervisor and children would also need an RPC protocol that stays compatible across eve
versions. Local users get reset, and revive if it ships. Postgres is the path for upgrades that keep
conversations.

## Open questions

1. **Workflow commitment.** Will Workflow take on routing, the build registry, and expand-only
   migrations for world-postgres?
2. **Build id granularity.** Should every `eve build` get a new id, as on Vercel? Or should it change
   only when replay compatibility changes (the eve version plus a hash of the workflow code)? The
   second keeps fewer builds live for teams that release often.
3. **Carried context.** Should carrying the transcript into the new session be on by default? How
   large should the transcript be before it's compacted? Should it include tool call names or
   results, or only user and assistant text?
4. **Linking a reset session to its predecessor.** What form should the link take: a
   `ctx.session.strandedFrom { sessionId, reason }` field, or a `session.reset` first event? It lets
   channels tell the user that the session was reset because of an upgrade.
5. **Stranded runs that never get another message.** Reset them eagerly at startup, or leave them
   `running`?
6. **Revive.** Is it worth its API surface and lifecycle quirks, given that reset with carried
   context recovers much of the conversation without them? Are new-session semantics acceptable to
   authors?
