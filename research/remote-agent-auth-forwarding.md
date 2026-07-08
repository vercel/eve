---
issue: https://github.com/vercel/eve/issues/604
status: proposed
last_updated: "2026-07-08"
---

# Forwarding end-user identity across remote agent hops

## Summary

A `defineRemoteAgent` hop drops the caller principal. Local subagent dispatch threads `auth` and
`initiatorAuth` onto the child `RunInput` (`execution/subagent-tool.ts`), so a child session sees
the same end user as its parent. The remote branch sends only
`{ callback, message, mode, outputSchema }` (`execution/remote-agent-dispatch.ts`), and
`OutboundAuthFn` is a zero-arg header factory, so the only identity that can cross the hop is
deployment-level trust. The receiving deployment authenticates the _calling app_
(`principalType: "runtime"` / `"service"`), never the end user.

This breaks per-user workloads split across deployments — most directly per-user Vercel Connect:
`resolveConnectionPrincipal` requires `session.auth.current.principalType === "user"` and fails
with `principal_required` when the session principal is the calling service. A router deployment
that authenticates end users over Slack cannot delegate to a `site-ops` deployment where each user
has OAuthed their own Datadog / GitHub / Vercel connection.

This plan adds explicit, opt-in auth forwarding on both sides of the hop. Only principal
_metadata_ (`SessionAuthContext`) crosses the wire — never tokens or credentials. The trust model
is "trusted forwarder": the transport auth (e.g. Vercel OIDC) authenticates the asserting
deployment, and the receiver names exactly which callers it trusts to assert a principal — the
same shape as `X-Forwarded-*` behind a trusted proxy, without token-exchange machinery.

```text
Slack user U ── router deployment ──────────────► site-ops deployment
               auth.current = U      POST /eve/v1/session
                                     headers: OIDC (router app identity)
                                     body.forwardedAuth: { current: U, initiator: U }
                                                    │
                                     eveChannel auth:          verifies router app
                                     eveChannel forwardedAuth: router app may forward
                                                    │
                                     session.auth.current = U ──► per-user Connect,
                                                                  local subagents,
                                                                  further remote hops
```

## Authoring API

### Sender: `forwardAuth` on `defineRemoteAgent`

```ts
// agent/subagents/site-ops.ts
import { defineRemoteAgent } from "eve";
import { vercelOidc } from "eve/agents/auth";

export default defineRemoteAgent({
  url: "https://site-ops.example.com",
  description: "Executes site operations as the requesting user.",
  auth: vercelOidc(), // transport trust: authenticates *this* deployment
  forwardAuth: true, // identity: asserts the current session principal
});
```

- `forwardAuth?: boolean`, default `false`. Forwarding identity to another deployment is an
  explicit decision, never ambient.
- When `true`, dispatch serializes the parent turn's `AuthKey` / `InitiatorAuthKey` (already in
  scope in `dispatch-runtime-actions-step.ts`) into a `forwardedAuth` field on the create-session
  body: `{ current: SessionAuthContext, initiator?: SessionAuthContext }`.
- If the parent turn has no auth (anonymous), the field is omitted, the call proceeds on
  transport trust alone, and no acceptance acknowledgment (below) is required.
- When the field is sent, the sender requires the receiver's response to acknowledge acceptance
  (`forwardedAuth: "accepted"` on the create-session response). A missing acknowledgment fails the
  dispatch inline, like any other failed remote start. Without this, a pre-forwarding eve receiver
  would silently ignore the unknown body field and run the session as the calling service — the
  exact silent downgrade this design rejects, reintroduced by version skew.
- The flag rides the module-backed runtime definition next to `auth` and `headers`; the compiled
  manifest node is unchanged.

### Sender: context-aware `OutboundAuthFn`

For schemes that mint a per-user credential at dispatch time (custom JWTs, token exchange),
`OutboundAuthFn` gains a context argument:

```ts
// eve/agents/auth
export interface OutboundAuthContext {
  /** Session principals of the dispatching turn. */
  readonly auth: {
    readonly current: SessionAuthContext | null;
    readonly initiator: SessionAuthContext | null;
  };
}

export type OutboundAuthFn = (ctx: OutboundAuthContext) => Promise<{
  readonly headers: Readonly<Record<string, string>>;
}>;
```

```ts
auth: async ({ auth }) => ({
  headers: { authorization: `Bearer ${await mintUserJwt(auth.current)}` },
}),
```

Pre-1.0 breaking type change; the built-ins (`vercelOidc`, `bearer`, `basic`) ignore the argument
and keep working, so only custom implementations touch their signature. `forwardAuth` is the
recommended path; a context-aware `auth` is the escape hatch for non-eve receivers or bespoke
credential schemes.

### Receiver: `forwardedAuth` on `eveChannel`

```ts
// agent/channels/eve.ts  (site-ops deployment)
import { eveChannel, vercelOidc, vercelSubject } from "eve";

export default eveChannel({
  auth: [vercelOidc()],
  // Only the router deployment may assert a forwarded principal.
  forwardedAuth: [vercelOidc({ subjects: [vercelSubject({ project: "router" })] })],
});
```

- `forwardedAuth?: AuthFn<Request> | readonly AuthFn<Request>[]`. Same primitive and `routeAuth`
  walk as `auth`, so trusted forwarders are expressed with the exact vocabulary already used for
  route protection — no new predicate or policy type.
- Semantics: the gate authenticates the _transport request_ (who is asserting), not the forwarded
  identity (what is asserted). The forwarded `SessionAuthContext` values are validated against a
  strict zod schema, mirroring how `callback` is validated today.
- The gate runs in **strict mode**: the Vercel OIDC always-on current-project bypass does not
  apply inside `forwardedAuth`, so only explicit `subjects` matches (or other explicit strategies)
  pass. Route `auth` keeps the bypass for convenience; impersonation authority does not — without
  this, any same-project caller, including preview deployments of the receiving project, could
  assert arbitrary principals against production Connect grants.

## Semantics

- **Accepted forwarding replaces the session principal.** `session.auth.current` = forwarded
  `current`; `session.auth.initiator` = forwarded `initiator` ?? forwarded `current`. Both seed
  `RunInput.auth` / `RunInput.initiatorAuth` exactly as if the user had called the deployment
  directly. Everything downstream works unchanged: `resolveConnectionPrincipal` sees
  `principalType: "user"` (per-user Connect resolves), local subagents inherit the principal, and
  a further `forwardAuth: true` remote hop chains the same identity onward.
- **Audit trail is receiver-written.** The receiver records the transport caller on the accepted
  contexts as attribute `eve:forwarded-by` = the _verified_ transport `principalId`, always
  overwriting any sender-supplied value — a forwarder must not be able to falsify the trail. On
  multi-hop chains (A→B→C) the attribute names the most recent hop only. Attributes do not affect
  Connect token-cache keying (`principalKey` uses issuer + id only).
- **`onMessage` still runs last.** `EveHandle.caller` is the forwarded principal once accepted;
  `defaultEveAuth` passes it through, and a custom `onMessage` can still override or drop, same as
  today.
- **Fail loud, never fall back silently.** A body carrying `forwardedAuth` when the channel has no
  `forwardedAuth` option → 403 ("this deployment does not accept forwarded auth"). Gate configured
  but the transport request fails it → 401/403 from `routeAuth`. Malformed `forwardedAuth`
  payload → 400. On acceptance, the 202 response carries `forwardedAuth: "accepted"`, which the
  sender requires (see the sender section) — covering the remaining silent path, an old receiver
  that ignores the field. Silently downgrading to the transport principal would surface later as
  an opaque `principal_required` deep inside a Connect call; a mismatch between the two
  deployments is a configuration error and should fail at the hop.
- **What never crosses the wire:** tokens, credentials, claims. Only the `SessionAuthContext`
  shape (`attributes`, `authenticator`, `issuer`, `principalId`, `principalType`, `subject`).
  Per-user provider credentials always live on the receiving deployment via its own Connect
  authorizations.
- **Events unchanged.** `subagent.called` and callbacks are untouched; forwarding is invisible to
  the parent stream.

## Boundaries and surfaces

| Surface                                                                    | Change                                                                                                |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `public/agents/auth.ts`                                                    | `OutboundAuthContext`; `OutboundAuthFn` takes it                                                      |
| `public/definitions/remote-agent.ts`                                       | `forwardAuth?: boolean`                                                                               |
| `execution/dispatch-runtime-actions-step.ts`                               | pass `auth` / `initiatorAuth` (already in scope) to remote dispatch                                   |
| `execution/remote-agent-dispatch.ts`                                       | build `forwardedAuth` body field; require the acceptance ack; call `remote.auth(ctx)` with context    |
| `channel/forwarded-auth.ts` (new)                                          | strict wire schema for `{ current, initiator? }`, beside `session-callback.ts`                        |
| `public/channels/eve.ts`                                                   | `forwardedAuth` option; gate (strict mode) + principal replacement + response ack on the create route |
| `docs/guides/remote-agents.md`, `docs/guides/auth-and-route-protection.md` | forwarding section on each side + trust-model warning                                                 |

Docs must carry the security guidance explicitly: scope `forwardedAuth` to named subjects (e.g.
`vercelSubject({ project })`); never include `none()` or a broad accept-all in the forwarder gate,
since any caller passing it can assert any principal.

## Out of scope

- Token exchange, delegation tokens, or forwarding credentials of any kind — the receiver mints
  its own per-user credentials via Connect.
- Forwarding to non-eve receivers (covered by the context-aware `OutboundAuthFn` escape hatch).
- Per-call forwarding decisions (the flag is per remote-agent definition).
- Reduced-scope or transformed principals (an `onMessage` override on the receiver already covers
  reshaping).
- Forwarding on the deliver route (`POST /eve/v1/session/:sessionId`). Remote dispatch is
  create-only today, so nothing in eve would send it; the same field + gate can extend to deliver
  if external eve clients need multi-turn forwarding later.

## Delivery and verification

Single PR with a **minor** changeset: the `OutboundAuthFn` signature change is a public API break
(zero-arg implementations remain assignable, but the exported type changes).

- Unit: wire schema (strict, malformed rejection), dispatch body construction with/without
  `forwardAuth` and with null auth, missing-ack dispatch failure, `OutboundAuthFn` receives the
  dispatching principals, receiver gate matrix (field without option → 403, gate failure →
  401/403, current-project bypass rejected in strict mode, accepted → principal replaced +
  `forwardedAuth: "accepted"` in the response, sender-supplied `eve:forwarded-by` overwritten).
- Integration: create route end-to-end in memory — forwarded principal becomes
  `session.auth.current` / `.initiator` and reaches `resolveConnectionPrincipal` as a `user`
  principal.
- Scenario: two in-process eve servers over real HTTP — router with `forwardAuth: true` dispatches
  to a receiver whose `forwardedAuth` gate accepts it, asserting the child session principal; plus
  the 403 mismatch path. (No remote-agent e2e fixture exists today; a scenario with a real HTTP
  boundary covers the hop without requiring a second CI deployment.)
