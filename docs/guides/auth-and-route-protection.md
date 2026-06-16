---
title: "Auth & Route Protection"
description: "Secure your agent's HTTP routes with an ordered auth walk, verifier helpers, and connection OAuth via Vercel Connect."
---

eve has two independent auth systems:

- **Route auth** (inbound) decides who can reach your agent's HTTP routes. It runs at the channel layer, gating the request before any model work runs.
- **Tool and connection auth** (outbound) is how your agent signs in to an external service it calls, like an OAuth MCP server. It happens later, when a tool or connection actually reaches out.

Start with route auth.

## Route auth

The route-auth policy lives on the HTTP channel factory (`agent/channels/eve.ts`) and guards three routes:

- `POST /eve/v1/session`
- `POST /eve/v1/session/:sessionId`
- `GET /eve/v1/session/:sessionId/stream`

These routes are protected by the channel's auth policy. eve fails closed by default: production browser traffic is rejected unless you configure an authenticator that accepts it, and anonymous access requires an explicit `none()`.

`GET /eve/v1/health` is always public and skips the walk entirely, so load balancers and uptime monitors can probe it without credentials.

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [localDev(), vercelOidc()],
});
```

## The ordered auth walk

`auth` takes a single `AuthFn` or an array that eve walks in order. Each entry has three possible outcomes:

- returns a `SessionAuthContext`: accept the request and stop the walk
- returns `null` / `undefined`: skip to the next entry
- **throws**: reject with a specific status

If every entry skips, the request gets a `401`. An empty array `auth: []` rejects everything.

```ts
import { type AuthFn, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { getSession } from "@/lib/auth";

function appSession(): AuthFn<Request> {
  return async (request) => {
    const session = await getSession(request);
    if (!session) return null; // skip; fall through to the next entry
    return {
      attributes: { providerId: session.providerId },
      authenticator: "app",
      principalId: session.userId,
      principalType: "user",
    };
  };
}

export default eveChannel({
  auth: [appSession(), localDev(), vercelOidc()],
});
```

Put your own providers ahead of the catch-all helpers. Any entry that doesn't recognize the caller returns `null`, and the walk moves on.

To reject with a precise status instead of skipping, throw:

```ts
import { ForbiddenError, UnauthenticatedError } from "eve/channels/auth";

throw new UnauthenticatedError({
  code: "authentication_required",
  message: "Sign in to continue.",
}); // 401
throw new ForbiddenError({ message: "Not allowed on this workspace." }); // 403
```

Any other thrown error follows the normal channel failure path. When building a custom channel on `defineChannel`, call `routeAuth(request, auth)` from `eve/channels/auth` to reuse the same walk semantics.

## Verifier helpers

`eve/channels/auth` ships these channel-auth helpers:

| Helper           | Use when                                                                  |
| ---------------- | ------------------------------------------------------------------------- |
| `localDev()`     | Local development. Accepts requests addressed to a loopback hostname.     |
| `vercelOidc()`   | The common Vercel deployment path. Verifies a Vercel OIDC bearer JWT.     |
| `none()`         | You want to accept anonymous traffic explicitly (use as the final entry). |
| `httpBasic(...)` | Operator or service access via a shared username/password.                |
| `jwtHmac(...)`   | You control a shared-secret JWT signer.                                   |
| `jwtEcdsa(...)`  | You verify asymmetric JWTs minted by another system.                      |
| `oidc(...)`      | You want eve to verify OIDC-issued tokens from an arbitrary issuer.       |

Exercise caution for agents that process non-public, sensitive, regulated, or production data unless you have implemented other access controls.

### `localDev()`

Authenticates a synthetic `local-dev` principal, but only when the inbound request is addressed to a loopback hostname (`localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`). The check keys off the request URL's hostname rather than the bare `process.env.VERCEL` flag, and that's deliberate: a deployment outside Vercel leaves `VERCEL` unset, so sniffing that flag alone would wave through all public traffic. There's one process-level exception. `vercel dev`, detected by `VERCEL=1` and `VERCEL_ENV=development` together, opens the local dev server even when it serves over a non-loopback host. Every other non-loopback request returns `null` and falls through.

`localDev()` trusts the advertised hostname, so an attacker who can inject a `Host` header (no normalizing proxy in front of your origin) can spoof it. Always layer a real authenticator on top; never run on `localDev()` alone.

### `vercelOidc()`

Verifies a bearer JWT against the [Vercel OIDC issuer](https://vercel.com/docs/oidc). Tokens minted for the current `VERCEL_PROJECT_ID` are always accepted, which is why internal subagent and runtime callers authenticate with zero configuration. Tokens carrying an `external_sub` authenticate as user callers, but only when their `project_id` matches `VERCEL_PROJECT_ID` and their environment matches `VERCEL_TARGET_ENV` / `VERCEL_ENV`. In that case `external_sub` becomes the session subject, and the profile claims (`name`, `picture`, `email`) show up in `ctx.session.auth.current.attributes`. To admit tokens minted by other Vercel projects, pass `subjects: [...]` (AWS IAM-style `*` wildcards).

Auth fails closed: routes reject unauthenticated traffic by default, and the OIDC user branch verifies `external_sub` against `VERCEL_PROJECT_ID` and the deployment environment, returning `false` when either is unset. An external-subject token cannot authenticate on a deployment that hasn't pinned its project.

#### `subjects` patterns and `vercelSubject(...)`

Each `subjects` entry is matched against the token's `sub` claim, which Vercel shapes as `owner:<team>:project:<name>:environment:<env>`. Hand-writing that string is a footgun: a typo silently rejects every caller, and an over-broad `*` wildcard silently lets unrelated ones in. Build the pattern with `vercelSubject(...)` instead. It rejects malformed input at construction time, and defaults `environment` to `"production"` when you omit it, so an unspecified environment cannot silently accept preview or development tokens:

```ts
import { vercelOidc, vercelSubject } from "eve/channels/auth";

vercelOidc({
  subjects: [
    vercelSubject({ teamSlug: "partner", projectName: "data" }), // environment defaults to "production"
    vercelSubject({ teamSlug: "acme", projectName: "agent", environment: "*" }),
  ],
});
```

`teamSlug` and `projectName` are the human-readable slugs Vercel embeds in `sub` (not the stable `team_…` / `prj_…` IDs), so they can't contain `:` or `*`. `environment` is `"production" | "preview" | "development" | "*"`. Only hand-write the subject string yourself when you actually mean to match across teams with a wildcard.

### Custom verifiers

When none of the shipped helpers fit, write your own `AuthFn` (the array example above) or call the low-level verifiers directly. Each verifier is the pure function sitting behind the matching strategy helper, and returns `{ ok: true, sessionAuth }` or `{ ok: false }`:

| Verifier                               | Behind         | Input                            |
| -------------------------------------- | -------------- | -------------------------------- |
| `verifyHttpBasic(header, credentials)` | `httpBasic()`  | raw `Authorization` header value |
| `verifyJwtHmac(token, config)`         | `jwtHmac()`    | bearer token (HMAC-signed JWT)   |
| `verifyJwtEcdsa(token, config)`        | `jwtEcdsa()`   | bearer token (ECDSA-signed JWT)  |
| `verifyOidc(token, config)`            | `oidc()`       | bearer token (OIDC, any issuer)  |
| `verifyVercelOidc(token, opts)`        | `vercelOidc()` | bearer token (Vercel OIDC)       |

Pull the token with `extractBearerToken(request.headers.get("authorization"))` before you hand it to the JWT/OIDC verifiers. The configs (`VerifyJwtHmacConfig`, `VerifyJwtEcdsaConfig`, `VerifyOidcConfig`) take `issuer`, `audiences`, the signing material (`secret` / `publicKey` / `discoveryUrl`), and optional `subjects` / `claims` matchers.

```ts
import { extractBearerToken, verifyJwtHmac, type AuthFn } from "eve/channels/auth";

function hmacAuth(): AuthFn<Request> {
  return async (request) => {
    const token = extractBearerToken(request.headers.get("authorization"));
    const result = await verifyJwtHmac(token, {
      algorithm: "HS256",
      issuer: "https://auth.example.com",
      audiences: ["agent"],
      secret: process.env.JWT_SECRET!,
    });
    return result.ok ? result.sessionAuth : null;
  };
}
```

### Failure responses in custom `defineChannel` routes

If a `defineChannel` route handler runs its own checks instead of `routeAuth`, it can still emit a framework-shaped failure with `createUnauthorizedResponse(...)`. You get back a `Response` with `cache-control: no-store`, a `{ ok: false, code, error }` JSON body, and one `www-authenticate` header per challenge:

```ts title="agent/channels/intake.ts"
import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";

export default defineChannel({
  routes: [
    POST("/message", async (req, { send }) => {
      if (!isAllowed(req)) {
        return createUnauthorizedResponse({
          status: 403, // defaults to 401; code defaults to "forbidden" / "unauthorized"
          message: "Not allowed on this workspace.",
          challenges: [{ scheme: "Bearer" }],
        });
      }
      // authenticated: handle the request
    }),
  ],
});
```

`UnauthenticatedError` and `ForbiddenError` wrap this builder (status `401` / `403`). Throw those from an `AuthFn` that `routeAuth` walks. Call `createUnauthorizedResponse` directly only when you're returning a `Response` from a hand-rolled route.

## Network policy

`eve/channels/auth` exports `createIpAllowList(...)` and `isIpAllowed(...)` for cutting off requests before any model work starts. A request that fails the network policy is dropped ahead of both auth and runtime execution.

## Replace `placeholderAuth` before production

`eve init` scaffolds `agent/channels/eve.ts` with a `placeholderAuth()` guardrail:

```ts
import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [localDev(), vercelOidc(), placeholderAuth()],
});
```

In production, `placeholderAuth()` returns a structured `401` so a generated web chat app can say "auth isn't configured yet" instead of throwing an internal error. Replace it before a browser caller submits a production request: swap in your app's `AuthFn` or one of the shipped helpers. Delete the authored channel file entirely and eve falls back to the framework default `[localDev(), vercelOidc()]`, which also rejects production browser traffic.

Keep secret values (`ROUTE_AUTH_BASIC_PASSWORD`, signing keys) in environment variables. Route-auth secrets never land in compiled artifacts. The runtime re-materializes them from the authored channel definition at boot.

## What reaches `ctx.session.auth`

Inside runtime code, `ctx.session.auth` carries the result of the channel's route auth (the walk above) forward as the caller snapshot:

- `auth.current`: the caller on the active inbound turn.
- `auth.initiator`: the caller that started the durable session.
- A follow-up message updates `auth.current` but leaves `auth.initiator` alone. When a different caller follows up on the same session, `auth.current` tracks the new caller for that turn while `auth.initiator` stays pinned to whoever started it.
- Both are `null` only on internal runtime paths (subagents, for instance) that never went through an authored route. HTTP traffic always populates `auth.current`, since the walk either accepts with a `SessionAuthContext` or returns `401`.

Use the principal on `auth.current` (or `auth.initiator`) to scope tools, resolve [dynamic capabilities](./dynamic-capabilities) per principal, or enforce tenant boundaries. There's no second per-session ownership ACL stacked on top of route auth. Access is decided at the HTTP boundary, and the durable session carries the caller snapshot forward into your runtime code.

Route auth does not enforce session ownership. If multiple users or tenants can reach the same route, you must implement the per-user, per-tenant, or per-session authorization your application requires.

## Tool and connection auth

Tool and connection auth is how your agent reaches an external service that wants an interactive sign-in, like an OAuth MCP server. Both a connection and an individual tool can declare an `auth` strategy; eve drives the sign-in, caches the token per step, and re-runs the call once the caller authorizes.

### On a connection

Attach `connect()` from `@vercel/connect/eve` to the connection:

```ts title="agent/connections/linear.ts"
import { connect } from "@vercel/connect/eve";
import { defineMcpClientConnection } from "eve/connections";
import { once } from "eve/tools/approval";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear: project management, issue tracking, and team workflows.",
  auth: connect("oauth/linear"),
  approval: once(),
});
```

The first call that needs the connection kicks off an OAuth sign-in, surfaced as an authorization challenge (a URL the caller visits). [Vercel Connect](https://vercel.com/docs/connect) brokers the flow and holds the credentials, which are resolved and cached per workflow step, never serialized into history, and never shown to the model. For non-interactive connections, pass a static token in place of `connect()`. [Connections](../connections) covers both shapes.

### On a single tool

When one tool calls a service behind OAuth, it can declare its own `auth` and skip the separate connection. `auth` takes the same shapes: `connect("...")` for Vercel Connect-backed OAuth, a custom interactive definition, or a plain `{ getToken }` for static credentials.

```ts title="agent/tools/list_okta_groups.ts"
import { defineTool } from "eve/tools";
import { connect } from "@vercel/connect/eve";
import { z } from "zod";

export default defineTool({
  description: "List the caller's Okta groups.",
  inputSchema: z.object({}),
  auth: connect("okta"),
  async execute(_input, ctx) {
    const { token } = await ctx.getToken();
    const res = await fetch("https://api.okta-proxy.internal/groups", {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.json();
  },
});
```

Declaring `auth` adds two accessors to the tool's `ctx`:

- `ctx.getToken()` resolves the bearer for the declared strategy, checking the per-step token cache first. With an interactive strategy, a cache miss suspends the turn on a framework-owned callback URL, shows a "Sign in" affordance, and re-runs the tool once the OAuth callback completes.
- `ctx.requireAuth()` throws `ConnectionAuthorizationRequiredError` to gate the tool on authorization before any token resolves. The runtime turns that into the same consent prompt.

Throw `ConnectionAuthorizationRequiredError` anywhere in `execute` (directly, via `requireAuth()`, or implicitly from `getToken()`) and you trigger the consent flow, keyed by the tool's name. Calling either accessor on a tool that does not declare `auth` throws.

By default the sign-in affordance title-cases the tool's path-derived name, so a tool file named `sfdc_lookup.ts` renders "Sign in with Sfdc_lookup". Set `displayName` on the `auth` definition to control what users see instead, for example `auth: { ...connect("sfdc"), displayName: "Salesforce" }`. It is presentation-only. The tool's name still keys the authorization scope, token cache, and callback URL, and a definition-level `displayName` wins over one the strategy stamps on the challenge.

## What to read next

- [Security model](../concepts/security-model): trust boundaries and the pre-production checklist
- [Connections](../connections): connection auth shapes (`connect()` vs static token)
- [Deployment](./deployment): where route-auth secrets live in production
