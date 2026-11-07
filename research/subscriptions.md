---
issue: "TBD (maintainer-requested research; no matching issue found)"
status: proposed
last_updated: "2026-10-21"
---

# Subscriptions: one primitive for schedules, connection events, and channel events

## Summary

Agents need to wake up when something happens: a time of day, an MCP server
event, a Slack post, or CI going red on a pull request the agent cares about.
eve already has three mechanisms that do this, and each is built differently:

| Mechanism                         | Event source    | Who creates the trigger         | Filter lives in            | What it wakes                                |
| --------------------------------- | --------------- | ------------------------------- | -------------------------- | -------------------------------------------- |
| `defineDynamicSchedules`          | provider clock  | model or authored code, runtime | schedule provider (timing) | a fresh, unattended session via `to()`       |
| `experimental_events` (MCP)       | Vercel Connect  | model, runtime                  | upstream MCP server (args) | the subscribing session via `attachSession`  |
| Channel hooks (`onCheckRun`, ...) | channel webhook | authored code, deploy time      | authored hook code         | the session that owns the continuation token |

This doc proposes a single `Subscription` primitive that all three are built
on: a durable, owned binding from an **event source** plus a **filter** to a
**target**, with a **lifetime** and an **identity** that is revalidated on
every delivery. Static channel hooks and static schedules become authored
subscriptions. Dynamic schedules, MCP event watches, and a new "subscribe to
channel events at runtime" capability become runtime subscriptions created
through one model-facing tool family.

The motivating case: an agent working on a pull request subscribes to GitHub
`check_run` events for that pull request, filtered to failures, and is woken in
the same conversation when CI breaks. Today that requires authoring
`onCheckRun` for every repository and every pull request up front.

Prior art: Jediah Katz describes the same primitive, called subscriptions, in
[Is the Agent Harness Dead?](https://www.youtube.com/watch?v=7Y4sbZgBdnc) around
15:30: rather than separate integrations for Slack posts, CI on a PR, or a time
of day, "we have one framework and one tool that the model can use or the agent
can use to subscribe to an event."

Paths are relative to `packages/eve/src/`.

## Does this make sense?

Yes, with one adjustment to the framing. Exposing `onMessage`-style channel
handlers to agents at runtime is the right capability, but the low-lift version
(a fourth, GitHub-specific mechanism) would add another copy of machinery eve
already has twice. The MCP connection-events implementation is most of a
generic subscription runtime already:

- a model-facing subscribe, get, and unsubscribe tool set with filter arguments
  and a TTL (`runtime/connections/events/actions.ts:282-339`);
- an idempotent binding id hashed from what is watched, not from the tool call
  (`actions.ts:243-255`);
- a durable per-watch workflow that stores the binding as hook metadata, sleeps
  until expiry or retirement, and retries cleanup (`workflow.ts:32-79`);
- delivery in its own durable step that revalidates the binding against the
  deployed definition and principal, then posts into the origin session with
  `turnPolicy: "queue"` (`dispatch-step.ts:17-116`).

Dynamic schedules contribute the other half: principal-scoped management
namespaces, a stored principal reference that is resolved to current auth at
fire time (`channel/schedule.ts:116-129`), and prepare, approve, and snapshot
for model writes (`context/schedule-collection-tools.ts:252-320`).

So the cheapest path to the GitHub use case and the path to one primitive are
mostly the same work: extract the connection-events core into a
source-agnostic subscription runtime, then add channel sources to it.

## Current state

### Channel events

- Each channel route parses its own webhook and dispatches directly. GitHub
  recognizes `issue_comment`, `pull_request_review_comment`, `issues`,
  `pull_request`, `check_suite`, `check_run`, and `workflow_run`; other events
  return `null` (`public/channels/github/inbound.ts:108-144`).
- CI events are opt-in through `onCheckSuite`, `onCheckRun`, and
  `onWorkflowRun` (`public/channels/github/githubChannel.ts:194-229`, dispatch at
  `:358-395`). With no hook configured the event is dropped.
- A dispatch calls `from(continuationToken).send(...)`. The per-PR token
  `repo:<id>:pull:<n>` already ties a CI event to the PR conversation
  (`inbound.ts:55-78`).
- GitHub dispatch runs under `waitUntil`, passes no `idempotencyKey`, and logs
  and swallows a failed send after the webhook already returned 200
  (`public/channels/github/dispatch.ts:341-353`). Fan-out to many subscribers
  needs a durable, keyed path instead.
- There is no channel-agnostic "inbound event to matching sessions" layer. The
  shared seams are `ChannelFrom`, `attachSession(sessionId)`, and
  `Session.send(message, { auth, idempotencyKey, turnPolicy })`
  (`channel/session.ts:122-149`).

### Connection events

- Opt-in per static MCP connection through `experimental_events`
  (`public/definitions/connections/events.ts:29-49`). Requires a Connect auth
  provider, no dynamic connections, and the root agent.
- One `events_subscribe_<hash>` tool per webhook-capable server event; the
  event's own `inputSchema` is the filter. Filtering happens upstream.
- Bindings capture `sessionId` and a deep clone of the creator's auth at
  subscribe time (`actions.ts:260`).
- Delivery is at-least-once, deduplicated by `deliveryId`.

### Dynamic schedules

- Storage is a `ScheduleProvider` interface
  (`public/schedules/subscription.ts:149-167`), with Vercel and in-memory
  implementations. Records hold timing plus an opaque, 64 KB envelope.
- Scope defaults to `byPrincipal`, hashed into a provider namespace
  (`runtime/schedules/collection-client.ts:319-329`).
- `run` delivers through `to(channel, target).send(...)`, which always starts a
  fresh unattended session; continuation into an existing conversation is
  explicitly disabled (`channel/schedule.ts:137-159`). The originating thread is
  not captured unless the author persists it through `preparePayload`.

## The primitive

A subscription has five parts. Each existing mechanism is one choice per part.

```text
           ┌──────────────┐   event    ┌──────────────┐  match   ┌──────────────┐
 source ──>│ source route │──────────> │ subscription │────────> │   target     │
           │ (verify,     │            │ index        │          │ (session or  │
           │  normalize)  │            │ (key lookup, │          │  channel)    │
           └──────────────┘            │  filter)     │          └──────────────┘
                                       └──────┬───────┘
                                              │ owner, identity, lifetime
                                              v
                                   revalidate on every delivery
```

1. **Source.** A named, typed event stream declared by a definition:
   `schedule:<collection>`, `connection:<name>:<event>`, or
   `channel:<name>:<event>`. The source declares the filter schema, the event
   shape, and whether filtering is remote (schedules, Connect) or local
   (channels).
2. **Filter.** Schema-validated arguments. Remote sources pass them upstream
   at open time. Local sources declare a `key(args)` for index lookup and an
   optional `match(event, args)` predicate, for example
   `key: repo:123:pull:45`, `match: conclusion === "failure"`.
3. **Target.** Either `{ kind: "session", sessionId }`, which attaches to the
   origin session with `turnPolicy: "queue"` and never creates a replacement,
   or `{ kind: "channel", channel, target }`, which starts a fresh session
   through the channel's `receive`. Runtime subscriptions default to the origin
   session; schedules default to a channel target. This makes "reply in the
   thread where I created this" the default instead of an authoring exercise.
4. **Lifetime.** `ttl`, `once` (retire after the first matching delivery, for
   "tell me when CI finishes"), and optional retirement when the target session
   ends.
5. **Identity.** A stored principal reference, resolved to current auth on
   every delivery, plus a scope that namespaces management. This is the
   schedule model; connection events would move from an auth snapshot to it.

Every delivery carries a stable `deliveryId` that becomes the
`Session.send` `idempotencyKey` (prefixed by source). Idempotency keys are
per-session (`execution/session/input-queue.ts:80-91`), so one webhook fanned
out to N sessions can reuse the same key safely.

### Authoring sketch

Names are illustrative.

```ts
// A channel declares which of its events are subscribable.
export default githubChannel({
  subscriptions: {
    check_run: {
      description: "CI check results on a pull request.",
      inputSchema: z.object({
        pullRequest: z.number().int(),
        conclusion: z.enum(["failure", "success", "any"]).default("failure"),
      }),
      key: (args, ctx) => `repo:${ctx.repository.id}:pull:${args.pullRequest}`,
      match: (event, args) =>
        args.conclusion === "any" || event.checkRun.conclusion === args.conclusion,
    },
  },
});
```

Static hooks are authored subscriptions over the same sources:

```ts
// Equivalent to today's onCheckRun, expressed as an always-on subscription.
onCheckRun: (ctx) => ({ auth: ctx.auth }),
// becomes sugar for an authored subscription with source channel:github:check_run,
// no filter, and a continuation-token target.
```

### Model surface

One tool family instead of a family per mechanism:

```ts
subscribe({ source, args, ttl?, once? }) // returns { id, source, expiresAt }
unsubscribe({ id })
list_subscriptions({ source?, cursor?, limit? })
```

`source` selects a per-source argument schema. Sources are catalog entries, so
with deferred tools the model finds them through `eve__search` rather than
carrying every schema in context. Approval follows the schedule pattern:
reads need none, writes are policy-driven per source, and the prepared filter
is snapshotted before approval.

Existing generated tools (`events_subscribe_<hash>`,
`schedule__<collection>__create`) stay as aliases during migration.

## Runtime design

### Index

Local sources need "event key to bindings" lookup; today a binding is
addressed only by its own hook token (`runtime/connections/events/owner.ts:102-118`).
Two options:

- **Topic workflow per key.** A durable workflow per routing key holds the set
  of bindings for that key. `subscribe` sends `add` to the topic hook, creating
  the workflow if absent; the source route resumes the topic hook with the
  event; the workflow evaluates `match` and starts one delivery step per
  binding. No new infrastructure, but hot keys grow the workflow's event log and
  serialize delivery.
- **`SubscriptionProvider` interface.** Mirrors `ScheduleProvider`:
  `put`, `delete`, `get`, `list(scope)`, and `query(source, key)`. A Vercel
  implementation backed by durable storage, an in-memory one for `eve dev` and
  tests, and a self-hosted extension point.

Recommendation: define the provider interface first and ship the topic-workflow
implementation as the default, so the storage choice can change without
changing the API. Schedules already prove the provider shape.

### Delivery

Each matching binding gets its own durable delivery step, modeled on
`dispatchConnectionEventStep`:

1. Re-read the binding and confirm the source definition still exists in the
   deployed artifacts.
2. Resolve current auth from the stored principal reference; drop the delivery
   if it resolves to `null`.
3. Re-check source-level access, for example that the principal can still read
   the repository.
4. Render the event as context with provenance (source, delivery id, sender),
   never as instructions.
5. Send to the target with the prefixed idempotency key. Retire the binding if
   `once`, if the target session is gone, or if the source reports termination.

The channel webhook route stays fast: verify, normalize, enqueue one durable
fan-out per event, return.

### Ownership and authorization

- Subscribing requires an authenticated, non-runtime principal, as schedule
  writes do today.
- Each source declares an `authorize(args, auth)` check run at subscribe time
  and on each delivery. A valid repository id in the arguments does not prove
  the principal can see that repository.
- Management is scoped by principal by default, so any of the creator's
  sessions can list or remove its subscriptions.

## Risks and open questions

- **Event storms.** CI produces bursts of `check_run` events. Sources should
  support coalescing (for example, debounce per key) and the runtime needs
  per-principal and per-session caps, which neither existing mechanism has.
- **Untrusted content.** Webhook bodies contain attacker-controllable text
  (commit messages, check output). Delivery must keep it in context blocks and
  preserve sender provenance.
- **Remote versus local filtering.** Connect filters upstream and the schedule
  provider computes timing; channels filter in eve. The source abstraction must
  allow both without leaking provider details into the model surface.
- **Auth snapshot versus revalidation.** Moving connection events to stored
  principal references changes their semantics and needs an `auth` resolver on
  the connection or a framework default.
- **Unattended targets.** A channel target starts a session that cannot ask for
  approval. Origin-session targets can, if the session is still interactive.
- **Provider availability.** The default schedule provider rejects preview and
  self-hosted deployments. A subscription provider should not inherit that
  limit for local sources, which need no external clock.
- **Coverage gaps.** GitHub drops `pull_request_review`, `push`, and `status`
  today. Subscribable sources should be explicit opt-ins per channel, not "any
  webhook event".

## Proposed stack

1. **Extract the core.** Move binding, owner, workflow, and delivery-step code
   from `runtime/connections/events/` into a source-agnostic
   `runtime/subscriptions/`. MCP connection events become the first source with
   no behavior change.
2. **Durable channel delivery.** Give GitHub dispatch an idempotency key derived
   from `X-GitHub-Delivery` and run it in a durable step. Useful on its own.
3. **Channel sources.** Add the `subscriptions` option to `githubChannel`, the
   index, and the generic `subscribe` tools. Ship `check_run`, `check_suite`, and
   `workflow_run` first.
4. **Schedules as a source.** Re-express `defineDynamicSchedules` on the
   subscription runtime with a time source, and add the origin-session target.
5. **Static hooks as authored subscriptions.** Lower `onCheckRun` and friends,
   and `defineSchedule`, to authored subscriptions so there is one dispatch path.
6. **More channels.** Slack (channel or thread messages matching a filter),
   Linear, and Teams.

Steps 1 to 3 deliver the PR-CI use case; steps 4 and 5 deliver the single
primitive.
