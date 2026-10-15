---
issue: https://github.com/vercel/eve/pull/4487
status: proposed
last_updated: "2026-10-07"
---

# Connection events that start new sessions

This is a design follow-up to [#4487](https://github.com/vercel/eve/pull/4487).
The API below is proposed, not implemented. It preserves the existing default:
subscriptions that continue an existing session end with that session. A watch
that starts fresh sessions needs an explicit opt-in and independent ownership.

## Proposed authoring API

Keep the configuration under `experimental_events`. Add a `session` discriminator;
omission means `"existing"`. This choice applies to watches created through that
connection definition and is saved when a watch is created.

Existing-session behavior remains unchanged:

```ts
experimental_events: {
  // session: "existing" is the default.
  async onEvent({ event, origin, auth, attachSession }) {
    await attachSession(origin.sessionId).send(
      `Review this issue:\n${JSON.stringify(event.data)}`,
      { auth, turnPolicy: "queue" },
    );
  },
}
```

The new mode offers creator-bound channel dispatch, following dynamic schedules:

```ts
experimental_events: {
  session: "new",

  // Application code resolves current permissions from a saved creator reference.
  // Return null when the creator no longer has permission to run this watch.
  async auth({ principal, origin }) {
    return resolveCurrentWatchAuth(principal, origin.connectionName);
  },

  async onEvent({ event, auth, to }) {
    // Application code derives the channel target from current authorization.
    const target = await resolveAuthorizedInbox(auth);
    await to(alerts, target).send(
      `Review this issue:\n${JSON.stringify(event.data)}`,
    );
  },

  async onGap({ origin, cursor, auth, to }) {
    // Reconcile the source or notify an authorized destination when needed.
  },
  async onTerminated({ origin, error, auth, to }) {
    // Optionally notify an authorized destination that monitoring has ended.
  },
}
```

`alerts` is an imported authored channel. `resolveCurrentWatchAuth` and
`resolveAuthorizedInbox` are application functions, not new eve exports. The
`auth` callback is required for `session: "new"`; returning a current auth context
for a different principal is rejected. Saved references identify the creator,
but do not retain bearer tokens or a snapshot of their permissions.

The types should discriminate the two callback contexts. Existing mode exposes
`attachSession`; new mode exposes `to`. New-mode `to(channel, target).send(message)`
binds the resolved creator internally and does not accept an auth override.
Keep separate `onEvent`, `onGap`, and `onTerminated` callbacks. Receiving an event
does not itself start a model turn; the callback decides whether to call `send`.

Each new-mode send starts fresh work, including when its channel already has an
active conversation. It must use dynamic schedules' fresh-session dispatch
semantics, not ordinary channel continuation. `turnPolicy` remains an
existing-session concern; it does not select a session or its lifetime.
As with dynamic schedules, these sessions run unattended: interactive input is
disabled, and they do not inherit the originating session's transcript or state.

## Lifetime and management

| Behavior                                     | Existing session (default)                     | New sessions (opt-in)                                                                 |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Watch owner                                  | Originating session                            | Durable subscription binding outside that session                                     |
| Session parks or finishes a turn             | Keep watching                                  | Keep watching                                                                         |
| Originating session expires, resets, or ends | Retire and cancel its watches                  | Keep watching                                                                         |
| `expiresAt: null`                            | Watch until stopped or the owning session ends | Watch until stopped, authorization is revoked, or upstream termination                |
| List/get/stop scope                          | Authorized creator and current session         | Authorized creator across sessions in the same application/environment and connection |
| `origin.sessionId`                           | Target session                                 | Creation metadata only                                                                |

The selected mode is authored configuration, not a model-callable argument.
Store it on creation; changing a connection's configuration must not silently
convert old watches. The initial implementation can require explicit stop and
recreation when changing modes. Two connection definitions can use the same
Connect connector with different modes when both behaviors are needed.

Use the existing monitoring deadline and stop operations. An infinite monitoring
lifetime does not mean unlimited capacity: independent watches need bounded
creation, active-watch quotas, and retention for stopped records. The current
100-binding per-session cap is insufficient for independent watches.

## Delivery and durable ownership

Keep the existing mounted `POST /eve/v1/hooks/:connectionName` receiver and
Connect verification. After verification, resolve an eve-owned binding using
the subscription ID and validate its application/environment, connection,
credential scope, creator, and saved mode. Delivery context can locate a record;
it cannot choose the execution principal or authorize dispatch.

Existing watches continue through the session inbox. Independent watches need
a durable receipt and callback workflow that do not depend on the original
session inbox. Acknowledge only after durable admission. Persist gap and
termination state before invoking the appropriate callback; retired watches
must not start new work. Already accepted callback retries remain distinguishable
from new deliveries.

Create a pending binding before contacting Connect, reconcile uncertain creates
with the original idempotency key, and retain early deliveries until the returned
subscription ID is durably bound. A fast upstream event must not be lost while
creation is committing. Recover pending creation and cancellation work after
crashes; neither can rely on the originating session still running.

Re-resolve creator authorization on every callback attempt, including lifecycle
callbacks. On an explicit denial, retire the watch and attempt upstream cleanup;
do not execute application callbacks under revoked permissions. A transient auth
lookup error remains retryable and must not be interpreted as a permanent denial.

Retries must not start another fresh session after a successful send whose
callback later failed. Persist each send's identity/result using the durable
workflow step mechanism, scoped by subscription, delivery, and send position.
Reconcile uncertain session creation before attempting another create. Callback
code may send more than once, so `deliveryId` alone is not a per-send identity.
The current schedule dispatcher generates a fresh random continuation token for
each send; reusing its routing semantics does not provide this retry guarantee.
The follow-up must add or reuse durable session-creation idempotency explicitly.
External application side effects remain at-least-once and need their own
idempotency keyed by delivery. Define receipt retention and replay behavior;
an indefinitely running watch cannot retain unlimited history in one workflow.

Independent callback failures have their own retry/failure reporting. They must
not fail the creation session or unrelated sessions started by other deliveries.
Only explicit stop, monitoring expiry, authorization revocation, or termination
retires the watch; a failed callback does not silently disable future deliveries.

## Reuse and surface changes

- **eve:** extend the experimental config, save the mode, add independent binding
  and receipt persistence, and dispatch callbacks with revalidated creator auth.
  Reuse [dynamic schedule auth and fresh-session dispatch](../packages/eve/src/channel/schedule.ts),
  [typed channel targets](../packages/eve/src/public/schedules/subscription.ts),
  existing workflow steps, and the current webhook verifier. Extract small shared
  primitives when needed; do not copy the schedule execution implementation.
- **Connect SDK/backend:** keep managed subscribe/get/list/unsubscribe and webhook
  verification. Connect owns upstream verification, renewal, and cancellation.
  eve owns application execution and its authorized binding. No AI SDK event store
  or new Connect store interface is required by this proposal.
- **AI SDK:** retain account-specific catalog discovery and the managed adapter.
  Session selection is an eve concern; the adapter does not gain routing fields.
- **Build summary:** retain the optional receiver capability from the separate
  summary follow-up. Once the config lands, optionally expose the authored mode.
  Do not publish live watches or creator identities in build metadata.

## Decisions to settle before implementation

The mode and lifetime contract above are the proposed API direction. The concrete
independent binding store and durable dispatch transport still need selection.
Evaluate existing eve/platform persistence first. The choice must support
conditional writes, indexed creator-scoped management, pending-creation recovery,
bounded receipt retention, and cancellation retry independently of session TTL.
Do not expose `session: "new"` as working before these guarantees exist.

Define supported deployment targets and how bindings resolve a compatible
connection definition after redeploy. Unsupported local/self-hosted setups must
fail clearly. A missing or incompatible connection must not dispatch through a
different definition. Also choose active-watch quotas, receipt retention, and an
operator-visible recovery path for exhausted callback or cleanup retries.

Implementation acceptance coverage must include continuation after the originating
session ends; preservation of default session-end cleanup; creator revalidation;
app credentials with distinct execution principals; early deliveries during
creation; crash/replay around session creation; explicit stop racing delivery;
gap/termination callbacks; and redeployment compatibility. Reuse and extend the
existing owning-boundary tests, then exercise durable recovery in CI.
