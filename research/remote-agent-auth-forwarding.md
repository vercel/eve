---
issue: https://github.com/vercel/eve/issues/604
status: implemented
last_updated: "2026-08-20"
---

# Forwarding end-user identity across remote agent hops

## Summary

A `defineRemoteAgent` hop drops the caller principal. Local subagent dispatch threads `auth` and
`initiatorAuth` onto the child `RunInput` (`execution/subagent-tool.ts`), so a child session sees
the same end user as its parent. The remote branch sends only
`{ callback, message, mode, outputSchema }` (`execution/remote-agent-dispatch.ts`), so the only
identity that can cross the hop is deployment-level trust. The receiving deployment authenticates
the _calling app_ (`principalType: "runtime"` / `"service"`), never the end user.

This breaks per-user workloads split across deployments — most directly per-user Vercel Connect:
`resolveConnectionPrincipal` requires `session.auth.current.principalType === "user"` and fails
with `principal_required` when the session principal is the calling service. A router deployment
that authenticates end users over Slack cannot delegate to a `site-ops` deployment where each user
has OAuthed their own Datadog / GitHub / Vercel connection.

This plan adds explicit, opt-in principal forwarding on both sides of the hop. Only principal
_metadata_ (`SessionAuthContext`) crosses the wire — never tokens or credentials. The trust model
is "trusted forwarder": the route's `auth` authenticates the asserting deployment as usual, and
the receiver authorizes forwarding with a predicate over that verified transport principal — the
same shape as `X-Forwarded-*` behind a trusted proxy, without token-exchange machinery.

Persistent remote children also accept continuation requests. Those requests must forward the
active parent turn's principal through the same trust gate: otherwise the child sees only the
calling deployment's service identity and per-user connections fail. A continuation replaces
only `auth.current`; `auth.initiator` remains pinned to the principal that created the child.

```text
Slack user U ── router deployment ──────────────► site-ops deployment
               auth.current = U      POST /eve/v1/session
                                     headers: OIDC (router app identity)
                                     body.forwardedPrincipal: { current: U, initiator: U }
                                                    │
                                     eveChannel auth:               verifies router app
                                     trustedForwarders(caller):   router app may forward
                                                    │
                                     session.auth.current = U ──► per-user Connect,
                                                                  local subagents,
                                                                  further remote hops
```

## Authoring API

### Sender: `forwardPrincipal` on `defineRemoteAgent`

```ts
// agent/subagents/site-ops.ts
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  url: "https://site-ops.example.com",
  description: "Executes site operations as the requesting user.",
  auth: vercelOidc(), // transport trust: authenticates *this* deployment
  forwardPrincipal: true, // identity: asserts the current session principal
});
```

- `forwardPrincipal?: boolean`, default `false`. Forwarding identity to another deployment is an
  explicit decision, never ambient.
- When `true`, creation serializes the parent turn's `AuthKey` / `InitiatorAuthKey` into a
  `forwardedPrincipal` field: `{ current: SessionAuthContext, initiator?: SessionAuthContext }`.
  Continuation serializes only the active `AuthKey`: `{ current: SessionAuthContext }`.
- The field is omitted only when `AuthKey` is `null` (the request was accepted with no
  credentials); the call then proceeds on transport trust alone. Any non-null context is forwarded as-is — including anonymous
  (`principalType: "anonymous"` from `none()`), schedule (`SCHEDULE_APP_AUTH`), and service
  principals — exact parity with how local subagent dispatch threads `auth`. Non-user principals
  still fail `principal_required` at Connect on the receiver, which is the correct outcome.
- The flag rides the module-backed runtime definition next to `auth` and `headers`; the compiled
  manifest node is unchanged.

### Receiver: `trustedForwarders` on `eveChannel`

```ts
// agent/channels/eve.ts  (site-ops deployment)
import { eveChannel, vercelOidc, vercelSubject } from "eve";

export default eveChannel({
  auth: [vercelOidc()],
  // Only the router deployment may assert a forwarded principal.
  trustedForwarders: (forwarder) =>
    forwarder.subject === vercelSubject({ teamSlug: "acme", projectName: "router" }),
});
```

- `trustedForwarders?: (caller: SessionAuthContext) => boolean | Promise<boolean>`. The
  predicate authorizes the _verified transport principal_ (who is asserting), not the forwarded
  identity (what is asserted). The route's `auth` walk has already authenticated the request; the
  forwarding decision is authorization over its result, so there is no second token verification
  and no new auth machinery.
- A predicate — rather than a second `AuthFn` walk — makes the Vercel OIDC always-on
  current-project bypass structurally irrelevant: the bypass lives inside `vercelOidc()` closures
  and cannot be disabled from the outside, and with a predicate the author must write an explicit
  match against the verified principal. Same-project callers (including preview deployments of
  the receiving project) get a transport principal whose `subject` simply does not match the named
  forwarder. `vercelSubject()` already produces the exact `sub` string to compare.
- The forwarded `SessionAuthContext` values are validated against a strict wire schema in a new
  `channel/forwarded-principal.ts`, mirroring how `callback` is validated today
  (`channel/session-callback.ts`). The schema is strict on keys but **must keep `authenticator`
  and `principalType` as open non-empty strings** (matching the public `SessionAuthContext`
  interface) with attribute values `string | string[]`. It must not mirror the private runtime
  schema in `runtime/sessions/auth.ts`, whose enums (`"http-basic" | "jwt-hmac" | ...`) would
  reject the flagship use case — a Slack-authenticated user has `authenticator: "slack-webhook"`.

## Semantics

- **Accepted forwarding replaces the active session principal.** On creation,
  `session.auth.current` = forwarded `current` and `session.auth.initiator` = forwarded
  `initiator` ?? forwarded `current`. On continuation, only `session.auth.current` changes;
  `session.auth.initiator` remains pinned. Everything downstream works unchanged:
  `resolveConnectionPrincipal` sees the active turn's user (per-user Connect resolves), local
  subagents inherit that principal, and a further `forwardPrincipal: true` remote hop chains it.
- **Caller authority is turn-scoped.** Local continuation always carries `SessionCommand.auth`,
  including `null`, so a later unauthenticated turn clears rather than inherits the previous
  caller. Remote continuation omits the assertion for `null` and the receiver uses its verified
  transport principal. Connection bearer caches are keyed by principal and virtual to one step;
  an upstream provider may retain each user's grant, but a turn can resolve only its current
  principal's grant.
- **Audit trail is receiver-written.** The receiver records the transport caller on the accepted
  contexts as attribute `eve:forwarded-by` = the _verified_ transport `principalId`, always
  overwriting any sender-supplied value — a forwarder must not be able to falsify the trail. On
  multi-hop chains (A→B→C) the attribute names the most recent hop only. Attributes do not affect
  Connect token-cache keying (`principalKey` uses issuer + id only).
- **`onMessage` still runs last, after stamping.** `eve:forwarded-by` is written before
  `onMessage` runs. `EveHandle.caller` is the forwarded principal once accepted, so
  `caller.attributes["eve:forwarded-by"]` is the window a custom `onMessage` has onto the
  transport caller; `defaultEveAuth` passes the forwarded principal through, and a custom
  `onMessage` can still override or drop, same as today.
- **Rejections fail loud.** A body carrying `forwardedPrincipal` when the channel has no
  `trustedForwarders` option → 403 ("this deployment does not accept a forwarded
  principal"). Predicate returns `false` → 403. Malformed `forwardedPrincipal` payload → 400. Each
  fails the sender's dispatch inline.
- **Mixed versions fail closed.** A receiver that supports forwarding only on session creation
  rejects a forwarded continuation with HTTP 400. The sender must not retry without the field:
  doing so would run the turn as the transport principal and silently change authority. The parent
  preserves the child handle, so the same session can be retried after the receiver is upgraded. A
  receiver that predates all principal forwarding may instead drop the unknown field and run as
  the transport principal, surfacing as `principal_required` at per-user Connect. Deploy both
  sides before resuming persistent remote sessions.
- **What never crosses the wire:** tokens, credentials, claims. Only the `SessionAuthContext`
  shape (`attributes`, `authenticator`, `issuer`, `principalId`, `principalType`, `subject`).
  Per-user provider credentials always live on the receiving deployment via its own Connect
  authorizations.
- **Events unchanged.** `subagent.called` and callbacks are untouched; forwarding is invisible to
  the parent stream. The cancel path is untouched: it authenticates with the definition's existing
  `auth` / `headers` and carries no forwarded identity.

## Boundaries and surfaces

| Surface                                                                              | Change                                                                                                                  |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `public/definitions/remote-agent.ts`                                                 | `forwardPrincipal?: boolean`                                                                                            |
| `execution/dispatch-runtime-actions-step.ts`                                         | pass `auth` / `initiatorAuth` (already in scope) to remote dispatch                                                     |
| `execution/tasks/parent/dispatch-task-step.ts`, `execution/agent-handle-dispatch.ts` | pass active `auth` through persistent local and remote continuation                                                     |
| `execution/remote-agent-dispatch.ts`                                                 | build `forwardedPrincipal` body field                                                                                   |
| `channel/forwarded-principal.ts` (new)                                               | strict wire schema for `{ current, initiator? }` (open `authenticator` / `principalType`), beside `session-callback.ts` |
| `public/channels/eve.ts`                                                             | `trustedForwarders` option; forwarded-principal gate + principal replacement on create and continuation routes          |
| `docs/guides/remote-agents.md`, `docs/guides/auth-and-route-protection.md`           | forwarding section on each side + trust-model warning                                                                   |

Docs must carry the security guidance explicitly: match the transport principal precisely (e.g.
`subject === vercelSubject({ teamSlug, projectName })`); a permissive predicate (`() => true`)
lets any authenticated caller assert any principal. Docs must also note that the framework default
channel has no `trustedForwarders`, so a receiving deployment must author its own
`agent/channels/eve.ts` to accept forwarded identity — forwarded bodies 403 until it does.

## Out of scope

- Token exchange, delegation tokens, or forwarding credentials of any kind — the receiver mints
  its own per-user credentials via Connect.
- A context-aware `OutboundAuthFn` (passing the dispatching turn's principals so custom schemes
  can mint per-user credentials for non-eve receivers). Adding a parameter to the function type
  later is fully non-breaking — zero-arg implementations remain assignable and eve is the only
  caller — so this waits for a concrete need. It would also have to define what context the
  cancel path passes, since `cancelRemoteAgentTurn` resolves headers through the same
  `resolveRemoteAgentRequestHeaders`.
- Per-call forwarding decisions (the flag is per remote-agent definition).
- Reduced-scope or transformed principals (an `onMessage` override on the receiver already covers
  reshaping).
- Cross-principal visibility of persistent child history, tool outputs, and artifacts. Principal
  forwarding selects the active turn's credential authority; applications that require private
  history must key child sessions by principal or enforce a same-principal ownership policy.
- A response acknowledgment (`forwardedPrincipal: "accepted"` on the 202) letting the sender
  detect a receiver that cannot apply the assertion. Considered and dropped: create-only receivers
  already reject forwarded continuations, the sender preserves the child handle for a retry after
  upgrade, and deployment docs make the coordinated-upgrade requirement explicit. Permanent wire
  surface was not justified by a transitional, pre-1.0 skew window.

## Delivery and verification

Single PR with a **patch** changeset: both options are additive; no public API breaks.

- Unit: wire schema (strict on keys, open `authenticator` / `principalType`, channel-produced
  contexts like `slack-webhook` accepted, malformed rejection), dispatch body construction with
  and without `forwardPrincipal` and with null auth (field omitted), receiver matrix (field
  without option → 403, predicate false → 403, predicate true → principal replaced,
  `eve:forwarded-by` stamped from the verified transport principal and sender-supplied values
  overwritten, stamping visible to `onMessage`).
- Unit/integration: continuation sends only active `current` when forwarding is enabled; the
  receiver applies the same trust gate, changes only `auth.current`, and local delivery replaces
  or clears the previous turn's `AuthKey`. Cover both persistent-session and tasks dispatch.
- Integration: create route end-to-end in memory — forwarded principal becomes
  `session.auth.current` / `.initiator` and reaches `resolveConnectionPrincipal` as a `user`
  principal.
- E2E: the `agent-subagents` loopback remote runs through a real HTTP hop. One parent turn creates
  the child as user A; a second, user-B-authenticated turn continues the same `childSessionId`.
  The child reports `auth.current` as B, keeps A as `auth.initiator`, and carries the
  receiver-written `eve:forwarded-by` attribute on both turns.
