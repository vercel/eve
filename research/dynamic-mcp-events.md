---
issue: "TBD (maintainer-requested plan; no dedicated issue)"
status: proposed
last_updated: "2026-10-21"
---

# Events on dynamic MCP connections

## Proposal

Let an app choose a user's MCP account at runtime and enable events on that
connection. For example, each user can connect their own Bird account and ask
eve to watch incoming email, without a connection file for every account.

Start with root-agent connections returned by `defineDynamic` at
`session.started`, a concrete `connect(...)` provider, and shared authored
callbacks. Preserve the existing watch workflow, subscription API, and callback
shape. This PR proposes the implementation; it does not enable the feature.

## Authoring

Proposed example against the current dynamic connection API:

```ts
// agent/connections/bird.ts
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { connect } from "@vercel/connect/eve";
import { getBirdAccount } from "../lib/accounts";
import { handleBirdEvent } from "../lib/bird-events";

export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const principal = ctx.session.auth.current;
      if (principal?.principalType !== "user") return null;
      const account = await getBirdAccount(principal);
      if (!account) return null;

      return defineMcpClientConnection({
        url: account.mcpUrl,
        description: "Read email and watch new messages",
        instanceKey: account.connectionKey,
        auth: connect(account.connector),
        experimental_events: {
          management: "creator",
          onEvent: handleBirdEvent,
        },
      });
    },
  },
});
```

`getBirdAccount` and `handleBirdEvent` are application functions. The account
lookup must authorize the user. `connectionKey` is a stable, non-secret account
identity that changes when the account or auth configuration changes.
`mcpUrl` must be an app-controlled, validated destination, never an arbitrary
URL supplied by the user.
The callback receives the existing `event`, `origin`, `auth`, `deliveryId`, and
`attachSession` fields. `onGap` and `onTerminated` work the same way.

Support a single definition, a named map, or `null`, following existing dynamic
connection naming. The first version excludes event-enabled `turn.started`
results, auth resolver functions, and callbacks that depend on transient
resolver-local state. Use shared module callbacks and load current application
data through an authorized lookup. Ordinary dynamic connections keep their
existing session and turn behavior.

## Current gaps

- [Dynamic resolution](../packages/eve/src/runtime/resolve-connection.ts)
  explicitly rejects `experimental_events`.
- [Route registration](../packages/eve/src/internal/nitro/host/application-route-registry.ts)
  creates receivers only for event-enabled connections known at build time.
- The [receiver](../packages/eve/src/internal/nitro/routes/connection-events.ts)
  obtains its verifier from a static connection. Callback dispatch and
  subscription lifecycle operations use
  [`resolveBinding`](../packages/eve/src/runtime/connections/events/dispatch-step.ts),
  which also searches only static connections.
- [Management actions](../packages/eve/src/runtime/connections/events/actions.ts)
  require a currently resolved connection. Removing an account can therefore
  remove the tool needed to stop its watch.

The existing [watch workflow](../packages/eve/src/runtime/connections/events/workflow.ts)
already saves its binding before subscribing, handles deliveries that arrive
before the subscribe response, and retries upstream cleanup. Extend that owner;
do not add a separate watch database or attach watch lifetime to a conversation.

## Delivery and recovery

```text
session resolver -> concrete connection -> saved watch -> Connect subscription
                                               |
verified webhook -> saved watch -> reconstruct exact connection -> callback
                                               |
                                       stop and cleanup
```

1. **Register a parameterized receiver.** Keep
   `POST /eve/v1/hooks/:connectionName`, including configured prefixes. Compile
   the route for agents with dynamic connection resolvers because returned
   connection names are unknown at build time. Validate route names and route
   conflicts, including namespaced extensions. Preserve static event handling.

2. **Verify before resolving user code.** Use Connect's existing delivery
   verification through an eve-owned boundary that does not need a live
   connection. Verify the actual destination path, then validate the echoed
   binding reference and load the saved watch. Do not invoke account resolvers
   or fetch an MCP URL based on an unverified request. Keep the verifier an
   optional integration; do not require every eve app to install Connect.

3. **Save reconstruction metadata with the watch.** Extend
   [`EventBinding`](../packages/eve/src/runtime/connections/events/state.ts)
   with the resolver's source ID and namespaced slug, plus the trusted context
   needed to rerun it. The binding already identifies the returned connection
   and instance; do not add a second entry identity or persist callbacks.
   Retain the resolver's trusted identity context and channel kind from its
   original evaluation, plus the watch creator's existing auth binding. Those
   identities can differ in a shared session; neither comes from webhook data.
   Persist only the required serializable metadata, never functions or OAuth
   credentials. Apply bounds consistent with existing durable context storage.

4. **Reconstruct and authorize the exact instance.** In a durable step, invoke
   only the referenced resolver with its saved resolution context. Select the
   saved entry, then check instance identity, connector, and the principal
   derived from the watch creator. Restore callbacks and the concrete provider
   together, preserving its scopes, subject mapping, and other Connect options.
   Do not substitute `connect(savedConnector)` for the original provider. A
   same-named static connection, another user's result, or the latest
   conversational caller must never become a fallback.

5. **Separate retry from retirement.** A thrown account lookup or temporary
   dependency failure retries through the existing durable workflow policy;
   it is not evidence of account removal. A successful resolution returning
   `null`, a missing entry, or a changed instance disables callback execution
   and retires that watch. A missing resolver has the same outcome while the
   receiver remains mounted. Stop watches before deleting the last dynamic
   resolver, or keep a resolver returning `null` until they retire. Trace the reason without logging credentials or event payloads.
   Do not invoke a replacement connection's `onTerminated` as a fallback.

Recovery uses `sessionStartedForResolvers` with the saved runtime identity,
just like existing session rehydration. It does not replay original fields
such as `predecessor`, emit another lifecycle event, or rebuild the conversation's
registry. Resolvers must be idempotent and work with this reconstructed event.
Invoke only the saved resolver so an unrelated account lookup cannot block a
watch. Keep the existing instance, connector, and principal checks.
Callbacks retain the existing retry contract: they can execute again after a
crash and must deduplicate effects using `deliveryId`.

## Stopping a removed connection

Applications can set `experimental_events.management: "creator"` to authorize
get/stop without reconstructing the connection. Opted-in subscribe results
return two dedicated management names, `eve__event_watch_get`
and `eve__event_watch_stop`, callable through `eve__tool` with the saved eve
watch ID. Keep these names distinct from connection tools so a replacement
account or a same-named static connection cannot capture the call. This first
version does not add cross-session watch listing or rediscovery.

These are explicitly app-authorized housekeeping operations, independent of
the current connection's discovery, auth, tool filters, and approval closures.
Save the opt-in with the original watch, including when a repeated subscribe
returns that watch. Without it, these actions reject access and are not
advertised. Changing the definition only changes future watches. Existing
connection get/stop actions retain their controls. Validate root-agent scope,
the watch ID, and the current execution principal against the saved owner before
using its connector and subscription ID. Do not expose removed catalogs or
create subscriptions through this path.

The watch workflow records stopping durably before upstream cleanup. Subsequent
receipt and queued callback execution must observe that marker. A callback
already executing may finish. Keep the owner available for cleanup retries and
report stopping separately from completion.

Connect's existing SDK get/unsubscribe calls accept a subscription ID without
an `expectedSubject`. The backend checks project/environment and connector
ownership and uses the subscription's saved upstream authorization. Use that
project-authorized path only for IDs loaded from eve's trusted, caller-authorized
watch. Do not forward a model-supplied Connect subscription ID. This preserves
custom subject/scopes without rebuilding a provider or storing tokens.

Cleanup uses the existing durable backoff, capped at one hour between attempts.
There is no new attempt cap: an outage must not silently abandon a subscription.
A missing subscription completes cleanup; persistent failures remain visible as
pending. No Connect SDK, AI SDK, or MCP protocol change is expected.

## Implementation and acceptance

First add shared dynamic result resolution and saved recovery context. Then wire
parameterized receipt, durable callback reconstruction, and management of removed
connections into the existing watch owner. Ship public docs and a patch changeset
with the runtime implementation; check extension contracts if types change.

The implementation must prove that unverified requests never invoke resolvers,
users cannot cross account boundaries, cold-start recovery preserves creator
identity, transient failures retry, and removal retires without switching accounts.
An opted-in watch must remain stoppable after connection removal, while a watch
without opt-in must reject the housekeeping path. Preserve static events,
early delivery, idempotency, expiry, and lifecycle callbacks. Cover the built
receiver in a deterministic fixture without real Bird credentials.

## Related proposals and review decisions

- [Dynamic capabilities with functions and memos (#4616)](https://github.com/vercel/eve/pull/4616)
  proposes replacing lifecycle maps. This example targets current main. If that
  lands first, adapt authoring and reconstruction to its evaluator and persisted
  observations instead of building another lifecycle-specific recovery system.
- [Subscriptions as one primitive (#5164)](https://github.com/vercel/eve/pull/5164)
  proposes sharing ownership across schedules, connection events, and channel
  events. Reuse that owner if it lands first. This proposal only adds dynamic
  connection support; it does not introduce another subscription primitive.

Review the initial session-only scope, the explicit opt-in to creator-authorized
management independent of connection tool policies, and project-authorized cleanup for saved watch IDs.
Shared callbacks are the supported authoring contract, not a promise that
arbitrary closures can be serialized or recovered.
