---
title: "Authentication"
description: "Secure your agent's HTTP routes with an ordered auth walk, verifier helpers, and connection OAuth via Vercel Connect."
---

eve has two independent auth systems:

- **Route auth** (inbound) decides who can reach your agent's HTTP routes. It runs at the channel layer, before any model work.
- **Tool and connection auth** (outbound) signs your agent in to an external service that a tool or connection calls, like an OAuth MCP server.

## Route auth

The route-auth policy lives on the HTTP channel factory (`agent/channels/eve.ts`) and guards these route groups:

- `POST /eve/v1/session`
- `POST /eve/v1/session/:sessionId`
- `POST /eve/v1/session/:sessionId/{cancel,compact,clear,end}`
- `GET /eve/v1/session/:sessionId/stream`

eve fails closed: production traffic is rejected unless an authenticator accepts it, and anonymous access requires an explicit `none()`.

The health route created by `eveChannel()` is public and skips the walk, so load balancers and uptime monitors can probe it without credentials. Replacing `agent/channels/eve.ts` with a custom `defineChannel(...)` or disabling that slot also replaces or removes the health route.

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [vercelOidc(), localDev()],
});
```

`vercelOidc()` is a convenience for Vercel-hosted agents and Vercel-to-Vercel callers, not a requirement. If your app already has users, sessions, API keys, or an identity provider, put a custom `AuthFn` for it in the `auth` walk instead.

## The ordered auth walk

`auth` takes a single `AuthFn` or an array that eve walks in order. Each entry has one of three outcomes:

| Entry                        | Result                                 |
| ---------------------------- | -------------------------------------- |
| Returns `SessionAuthContext` | Accepts the request and stops the walk |
| Returns `null` / `undefined` | Skips to the next entry                |
| Throws                       | Rejects with a specific status         |

If every entry skips, the request gets a `401`. Its `WWW-Authenticate` header advertises the schemes the entries declare:

- `Basic` for `httpBasic()`.
- `Bearer` for `jwtHmac`, `jwtEcdsa`, `oidc`, and `vercelOidc`.
- `Bearer` for entries that declare none, such as a custom `AuthFn` or an empty array.

See [`withAuthChallenges`](#custom-verifiers) to declare a scheme on a custom `AuthFn`.

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
  auth: [appSession(), vercelOidc(), localDev()],
});
```

Put your own providers ahead of the catch-all helpers, and `localDev()` last. A `vercelOidc()` before `localDev()` lets a local Vercel OIDC bearer resolve a real user instead of the stand-in `local-dev` caller. On non-Vercel hosts, omit `vercelOidc()` unless you want to accept Vercel-issued tokens.

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

`eve/channels/auth` ships these helpers:

| Helper           | Use when                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `localDev()`     | Local development. Accepts requests only while the process is an `eve dev` or `vercel dev` server. |
| `vercelOidc()`   | The common Vercel deployment path. Verifies a Vercel OIDC bearer JWT.                              |
| `none()`         | You want to accept anonymous traffic explicitly (use as the final entry).                          |
| `httpBasic(...)` | Operator or service access via a shared username/password.                                         |
| `jwtHmac(...)`   | You control a shared-secret JWT signer.                                                            |
| `jwtEcdsa(...)`  | You verify asymmetric JWTs minted by another system.                                               |
| `oidc(...)`      | You want eve to verify OIDC-issued tokens from an arbitrary issuer.                                |

`httpBasic(credentials, { realm })` renders `realm` on the `WWW-Authenticate: Basic` challenge (e.g. `Basic realm="agent", charset="UTF-8"`) so browsers label their login prompt. Omit `realm` to use `"eve"`. Usernames and passwords are normalized to Unicode NFC before comparison.

Exercise caution for agents that process non-public, sensitive, regulated, or production data unless you have implemented other access controls.

### `localDev()`

Accepts the request as a stand-in `local-dev` caller, but only on a local development server: `eve dev` (which sets `EVE_DEV=1`) or `vercel dev` (`VERCEL=1` and `VERCEL_ENV=development` together). No request header can change this. A production deployment (`eve start`, a Vercel deployment, or any container host) sets neither flag, so every request falls through to the next entry.

On a development server, `localDev()` refuses browser requests for another website. It refuses a request when its host or `Origin` is neither a loopback host nor one of this machine's addresses. A web page the developer opens can't call the local agent, even through DNS rebinding. A frontend on any loopback host and port, such as `http://localhost:3000` calling `http://127.0.0.1:2000`, still authenticates.

On `eve dev`, `localDev()` also refuses connections from another machine, so LAN callers of `eve dev --host 0.0.0.0` aren't accepted as `local-dev`. A tunnel or reverse proxy on the same machine, such as ngrok or a local nginx, connects locally, so its callers still get `local-dev`.

`localDev()` is safe to leave in the walk. Still put a real authenticator ahead of it so production traffic has something to match.

### `vercelOidc()`

Verifies a bearer JWT against the [Vercel OIDC issuer](https://vercel.com/docs/oidc). Tokens minted for the current `VERCEL_PROJECT_ID` are always accepted, so internal subagent and runtime callers authenticate with no configuration. To admit tokens from other Vercel projects, pass `subjects: [...]` (AWS IAM-style `*` wildcards).

Tokens carrying an `external_sub` authenticate as user callers. Their `project_id` must match `VERCEL_PROJECT_ID`, and their environment must match `VERCEL_TARGET_ENV` / `VERCEL_ENV`. If either variable is unset, these tokens fail. `external_sub` becomes the session subject, and the `name`, `picture`, and `email` claims appear in `ctx.session.auth.current.attributes`.

`vercelOidc()` only authenticates. To also permit [stubbed eval sessions](../evals/tool-stubs), use `eveVercelOidc` from `eve/channels/eve` with the same options. Its subject entries can grant [tool replacement permission](#tool-replacement-permission): `{ subject: vercelSubject({ teamSlug: "acme", projectName: "eval-runner" }), allowToolStubs: true }`. Plain subject strings, and tokens accepted only because they come from the current project, grant ordinary access only.

#### `subjects` patterns and `vercelSubject(...)`

Each `subjects` entry is matched against the token's `sub` claim, shaped `owner:<team>:project:<name>:environment:<env>`. A hand-written typo silently rejects every caller, and an over-broad `*` silently admits unrelated ones, so build the pattern with `vercelSubject(...)`. It rejects malformed input at construction time. Omit `environment` to match only `"production"`:

```ts
import { vercelOidc, vercelSubject } from "eve/channels/auth";

vercelOidc({
  subjects: [
    vercelSubject({ teamSlug: "partner", projectName: "data" }), // environment defaults to "production"
    vercelSubject({ teamSlug: "acme", projectName: "agent", environment: "*" }),
  ],
});
```

`teamSlug` and `projectName` are the human-readable slugs in `sub`, not the `team_…` / `prj_…` IDs, and can't contain `:` or `*`. `environment` is `"production" | "preview" | "development" | "*"`. Hand-write the subject string only to match across teams with a wildcard.

### Custom verifiers

When no helper fits, write your own `AuthFn` (the array example above) or call the low-level verifiers directly.

A custom `AuthFn` declares no `WWW-Authenticate` scheme, so `routeAuth` falls back to `Bearer`. Wrap it with `withAuthChallenges(fn, challenges)` to declare the schemes it satisfies, so a mixed `auth` array produces an accurate 401:

```ts
import { withAuthChallenges, type AuthFn } from "eve/channels/auth";

const apiKeyAuth: AuthFn<Request> = withAuthChallenges(
  (request) => (isValidApiKey(request) ? apiKeySessionAuth : null),
  [{ scheme: "Bearer" }],
);
```

Each verifier is the pure function behind a helper and returns `{ ok: true, sessionAuth }` or `{ ok: false }`:

| Verifier                               | Behind         | Input                            |
| -------------------------------------- | -------------- | -------------------------------- |
| `verifyHttpBasic(header, credentials)` | `httpBasic()`  | raw `Authorization` header value |
| `verifyJwtHmac(token, config)`         | `jwtHmac()`    | bearer token (HMAC-signed JWT)   |
| `verifyJwtEcdsa(token, config)`        | `jwtEcdsa()`   | bearer token (ECDSA-signed JWT)  |
| `verifyOidc(token, config)`            | `oidc()`       | bearer token (OIDC, any issuer)  |
| `verifyVercelOidc(token, opts)`        | `vercelOidc()` | bearer token (Vercel OIDC)       |

Extract the token with `extractBearerToken(request.headers.get("authorization"))` before passing it to the JWT/OIDC verifiers. The configs (`VerifyJwtHmacConfig`, `VerifyJwtEcdsaConfig`, `VerifyOidcConfig`) take `issuer`, `audiences`, the signing material (`secret` / `publicKey` / `discoveryUrl`), and optional `subjects` / `claims` matchers.

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

A `defineChannel` route that runs its own checks instead of `routeAuth` can return a framework-shaped failure from `createUnauthorizedResponse(...)`. The `Response` has `cache-control: no-store`, a `{ ok: false, code, error }` JSON body, and one `www-authenticate` header per challenge:

```ts title="agent/channels/intake.ts"
import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";

export default defineChannel({
  routes: [
    POST("/message", async (req) => {
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

`UnauthenticatedError` (`401`) and `ForbiddenError` (`403`) wrap this builder; throw them from an `AuthFn` that `routeAuth` walks. Call `createUnauthorizedResponse` directly only when returning a `Response` from a hand-rolled route.

## Network policy

`eve/channels/auth` exports `createIpAllowList(...)` and `isIpAllowed(...)`. A request that fails the network policy is dropped before auth and runtime execution.

## Replace `placeholderAuth` before production

`eve init` scaffolds `agent/channels/eve.ts` with a `placeholderAuth()` guardrail:

```ts
import { eveChannel } from "eve/channels/eve";
import { localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

export default eveChannel({
  auth: [vercelOidc(), localDev(), placeholderAuth()],
});
```

In production, `placeholderAuth()` returns a structured `401`, so a generated web chat app can report that auth isn't configured. Replace it with your app's `AuthFn` or a shipped helper before browser callers reach production. Without an authored channel file, eve uses the same `[vercelOidc(), localDev(), placeholderAuth()]` policy, which also rejects production traffic.

You don't have to keep `vercelOidc()`. For a self-hosted app, an app-embedded frontend, or a non-Vercel identity system, use `httpBasic()`, `jwtHmac()`, `jwtEcdsa()`, generic `oidc()`, or a custom `AuthFn`. A custom `AuthFn` maps your verified user, session, or API key to a `SessionAuthContext`.

Keep secret values (`ROUTE_AUTH_BASIC_PASSWORD`, signing keys) in environment variables. Route-auth secrets are never written into build output. eve reads them from your channel file when the server starts.

## Accepting forwarded identity from another deployment

A `defineRemoteAgent({ forwardPrincipal: true })` caller (see [Remote agents](./remote-agents#forwarding-the-caller-identity)) sends its end user's identity on create and follow-up requests as a `forwardedPrincipal` body field. eve rejects every forwarded identity with `403` until you name the forwarders you trust with `trustedForwarders` on `eveChannel`:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { vercelOidc, vercelSubject } from "eve/channels/auth";

export default eveChannel({
  auth: [vercelOidc()],
  // Only the router deployment may forward eve delegation context.
  trustedForwarders: (forwarder) =>
    forwarder.subject === vercelSubject({ teamSlug: "acme", projectName: "router" }),
});
```

`trustedForwarders` lets the verified forwarder supply delegation context: the user's identity, the parent session chain, and, when it forwards an identity, trace-content limits. Match it precisely: `() => true` grants this authority to every caller that passes route auth, including preview deployments accepted by `vercelOidc()`. eve's default channel rejects forwarded identities and ignores the other context.

### Limiting what a forwarder may assert

A predicate that checks only the forwarder lets it claim any identity, such as a Slack user or app identity your tools trust. To limit a forwarder to its own users, check the claim in the predicate's second argument:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { vercelOidc, vercelSubject } from "eve/channels/auth";
import type { SessionAuthContext } from "eve/context";

const router = vercelSubject({ teamSlug: "acme", projectName: "router" });

/** The router forwards only users signed in through its own identity provider. */
function isRouterUser(context: SessionAuthContext): boolean {
  return (
    context.authenticator === "router-sso" &&
    context.issuer === "router" &&
    context.principalType === "user"
  );
}

export default eveChannel({
  auth: [vercelOidc()],
  trustedForwarders: (forwarder, assertion) =>
    forwarder.subject === router &&
    assertion.principal !== undefined &&
    isRouterUser(assertion.principal.current) &&
    isRouterUser(assertion.principal.initiator),
});
```

`assertion.principal` holds the `current` and `initiator` contexts the forwarder claims, already stamped with `eve:forwarded-by`. `initiator` equals `current` when the sender omits it. The forwarder supplies attributes too, so check any attribute your tools trust.

`initiator` takes effect only when the session is created. On a follow-up request, the predicate still sees the claimed `initiator`, but the session keeps its original initiator. Checking `initiator` on a follow-up doesn't change that original value.

`assertion.principal` is absent when a request forwards the parent session chain without an identity. A predicate that requires `assertion.principal` accepts that forwarder's session chain only alongside an identity it accepts. The `ForwardedAssertion` and `TrustedForwarders` types are exported from `eve/channels/eve` for named predicates.

When the predicate accepts a create request, `ctx.session.auth.current` and `.initiator` carry the forwarded user as if they had called your deployment directly. On a follow-up request, only `auth.current` is replaced. User-scoped connections, local subagents, and further `forwardPrincipal` hops see the active turn's caller.

The receiver always overwrites the `eve:forwarded-by` attribute on accepted contexts, so a forwarder can't falsify it. A forwarded body without `trustedForwarders`, or one the predicate refuses, gets `403`; a malformed payload gets `400`. Only identity metadata reaches the receiver, never tokens or credentials.

A trusted parent session chain fills `ctx.session.parent` and keeps the same root session across every hop. eve ignores an untrusted chain. The root session's normal token cap still applies to an accepted chain.

A remote delegation request carries a callback body and a valid sampled `traceparent`. On such a request, an accepted `trustedForwarders` result can also admit an origin audience and input and output content limits from one W3C Baggage member. These values grant no authorization. The receiver's own trace policy also decides, using the origin audience. eve keeps only what both decisions allow, and later hops forward only that narrowed result. A malformed, partial, unsampled, or mixed-version value falls back to metadata-only tracing. The caller supplies the callback and headers, so trust rests only on the verified caller identity and `trustedForwarders`. See [Preserving trace content](./remote-agents#preserving-trace-content).

W3C `traceparent`, `tracestate`, and the forwarded conversation ID are correlation metadata. They don't require `trustedForwarders`, link sessions, or grant session access.

> ⚠️ Both deployments must support forwarding on follow-up requests before you resume persistent remote sessions. A receiver that supports forwarding only on create rejects a forwarded follow-up with HTTP 400. The sender doesn't fall back to sending as its own service. See [Forwarding the caller identity](./remote-agents#forwarding-the-caller-identity).

Subagent sessions persist by default but don't keep a caller's access between turns. Every accepted follow-up replaces `auth.current`, and clears it when an internal local message has no caller. Per-user connections use that caller, so a later caller can't use a prior caller's OAuth grant. A caller allowed to continue the session still sees its conversation history and artifacts. Your application decides who may use a session.

## What reaches `ctx.session.auth`

Inside runtime code, `ctx.session.auth` carries the channel's route-auth result as a caller snapshot:

- `auth.current`: the caller on the active inbound turn. A follow-up from a different caller replaces it for that turn.
- `auth.initiator`: the caller that started the session. It never changes.

The caller stays the same for the whole turn; only its claims can change:

- A message from the turn's own caller joins the turn and updates `auth.current` with its claims. This includes a typed answer to a pending `ctx.ask()` or `ask_question`.
- A message from anyone else waits for the turn to end and runs as its own turn.
- Someone else can still answer a pending request with a button or structured response. The request then records them as its responder, and the turn keeps its `auth.current`.

`auth.current` is whatever `auth` the channel sent the message with. A route handler or channel hook can send with `auth: null`, such as `source.send(message, { auth: null })` or a Slack `onMessage` hook that returns `{ auth: null }`. On a new session, both values are then `null`; on a continuation, only `auth.current` is. Internal runtime paths, such as subagents, can also have no caller auth.

Use the caller on `auth.current` (or `auth.initiator`) to limit tools, choose [dynamic tools, skills, and other definitions](./dynamic-capabilities) per user, or enforce tenant boundaries.

Route auth doesn't check who may use a session, and eve adds no per-session access list. If multiple users or tenants can reach the same route, implement the per-user, per-tenant, or per-session authorization your application requires.

## Tool replacement permission

Creating a [stubbed eval session](../evals/tool-stubs) requires `allowToolStubs: true` in the verified route authentication result; request JSON can't grant it. With `eveVercelOidc`, put the grant on a `subjects` entry, as in the [tool stubs example](../evals/tool-stubs#permit-tool-replacement). Any matching entry with the grant permits replacement, and other entries don't revoke it. Tokens accepted only because they come from the current project, and user callers, don't inherit project grants.

Custom authenticators return the same grant after verifying their caller. Type a standalone callback as `EveAuthFn` from `eve/channels/eve`. This channel permits stubs only in local development:

```ts
import { localDev } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const authenticate = localDev();
export default eveChannel({
  auth: async (request) => {
    const caller = await authenticate(request);
    return caller ? { ...caller, allowToolStubs: true } : null;
  },
});
```

eve removes the grant from the caller identity before it forwards or saves that identity, or uses it for audience classification.

Later messages, approvals, controls, and result reads use normal channel authentication without rechecking the grant. Anyone your channel admits to an existing session can use its configured stubs, so apply the same session-access policy as for ordinary sessions.

## Agent info access

`GET /eve/v1/info` returns authored instructions and server paths, so it serves only operators by default: `service` and `runtime` principals, plus callers `localDev()` admits when the channel's `auth` includes it. Other callers get `403` with code `info_forbidden`. An eve-channel authenticator can decide for its caller instead: `allowAgentInfo: true` grants access, and `false` denies it even to an operator. Like `allowToolStubs`, the flag applies only to the current request and is never persisted or forwarded.

```ts
import type { EveAuthFn } from "eve/channels/eve";

const authenticateStaff: EveAuthFn = async (request) => {
  const staff = await verifyStaffSession(request);
  return staff ? { ...staff, allowAgentInfo: true } : null;
};
```

## Tool and connection auth

Tool and connection auth signs your agent in to an external service that needs an interactive sign-in, like an OAuth MCP server. Connections declare `auth` on the connection definition. Tools resolve providers inline with `ctx.getToken(provider)` and call `ctx.requireAuth(provider)` only when a downstream service rejects a token. eve drives the sign-in, reuses the token within a step, and re-runs the call once the caller authorizes.

The user for user-scoped auth comes from route auth. `connect("...")` from `@vercel/connect/eve` defaults to `principalType: "user"`, so OAuth can start only when `ctx.session.auth.current.principalType === "user"`. An anonymous, local-dev, runtime, or service session fails fast with `reason: "principal_required"`, because no end-user identity exists to bind the grant to.

Use app-scoped auth when the external service should act as the agent itself:

```ts
auth: connect({ connector: "linear/myagent", principalType: "app" });
```

Use user-scoped auth when the external service should act as the signed-in person:

```ts
auth: connect("linear/myagent");
```

For user-scoped auth in a browser app, have the eve channel's route auth verify your app session and return a user identity:

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { localDev, type AuthFn } from "eve/channels/auth";
import { getSession } from "@/lib/auth";

function appSession(): AuthFn<Request> {
  return async (request) => {
    const session = await getSession(request);
    if (!session) return null;

    return {
      authenticator: "app",
      principalId: session.userId,
      principalType: "user",
      attributes: {
        email: session.email,
        teamId: session.teamId,
      },
    };
  };
}

export default eveChannel({
  auth: [appSession(), localDev()],
});
```

Keep `principalId` stable for the same person, and include an `issuer` when the app accepts users from multiple identity providers. eve keys user credentials by issuer and principal ID, so two identity providers can't share a grant.

Built-in platform channels that identify a human sender attach a user identity for that sender by default. These include Slack, Discord, Teams, Telegram, Twilio, Linear, and GitHub. A Slack mention, DM, or button click can authorize a user-scoped connection for that Slack user without a browser-session auth function.

### On a connection

Set `auth` on an MCP or OpenAPI connection when the external service supplies a family of remote tools. The [connections overview](../connections) owns the shared `connect()` setup, static-token providers, app and user scope, approval prompt, and self-hosted OAuth flow.

### On a single tool

When one tool calls a service behind OAuth, keep the auth provider at the call site instead of adding a connection. Providers take the same shapes as connection `auth`: `connect("...")` for Vercel Connect-backed OAuth, a custom interactive definition, or a plain `{ getToken }` for static credentials.

```ts title="agent/tools/list_okta_groups.ts"
import { defineTool } from "eve/tools";
import { connect } from "@vercel/connect/eve";
import { z } from "zod";

const oktaAuth = connect("okta/myagent");

export default defineTool({
  description: "List the caller's Okta groups.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const { token } = await ctx.getToken(oktaAuth);
    const res = await fetch("https://api.okta-proxy.internal/groups", {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.json();
  },
});
```

The same inline shape handles tools that need more than one credential:

```ts title="agent/tools/sync_ticket.ts"
import { connect } from "@vercel/connect/eve";
import { defineTool } from "eve/tools";
import { z } from "zod";

const githubAuth = connect("github/myagent");
const linearAuth = connect("linear/myagent");

export default defineTool({
  description: "Sync GitHub context into Linear.",
  inputSchema: z.object({ issueId: z.string() }),
  async execute({ issueId }, ctx) {
    const { token: githubToken } = await ctx.getToken(githubAuth);
    const { token: linearToken } = await ctx.getToken(linearAuth);

    const repo = await fetch("https://api.github.com/user/repos", {
      headers: { authorization: `Bearer ${githubToken}` },
    });
    if (repo.status === 401) ctx.requireAuth(githubAuth);

    return updateLinearIssue(issueId, linearToken, await repo.json());
  },
});
```

Configure OAuth targeting on the provider. For Vercel Connect, pass `tokenParams` to `connect(...)` for explicit OAuth scopes, resource indicators, or rich authorization requests:

```ts
const githubAuth = connect({
  connector: "github/myagent",
  tokenParams: {
    authorizationDetails: [
      {
        type: "github_app_installation",
        org: "acme",
        repositories: ["agent-runtime"],
      },
    ],
  },
});
```

The tool's `ctx` exposes provider-scoped auth accessors:

- `ctx.getToken(provider, options?)` resolves an inline provider such as `connect("github/myagent")`. It uses the same cache, callback, and sign-in flow as connection auth, keyed to this tool and that provider.
- `ctx.requireAuth(provider, options?)` evicts that provider's cached token and starts a fresh authorization challenge. Use it after a downstream `401` rejects a token from `ctx.getToken(provider)`.

Throw `ConnectionAuthorizationRequiredError` from an inline provider's `getToken` to start that provider's consent flow.

Vercel Connect providers usually supply their own display name for the authorization challenge. To override what users see, set `displayName`, for example `ctx.getToken(customAuth, { displayName: "Salesforce" })`.

Inline providers derive a stable auth key from Vercel Connect metadata when available. Give each custom provider without that metadata an explicit key, for example `ctx.getToken(auth, { authKey: "github" })`. `authKey` sets eve's cache and callback keys; it is not an OAuth scope.

## What to read next

- [Security model](../concepts/security-model): trust boundaries and the pre-production checklist
- [Connections](../connections): connection auth shapes (`connect()` vs static token)
- [Multi-tenant outbound auth](../patterns/multi-tenant-auth): select tenant-scoped outbound credentials from the verified inbound identity
- [Deployment](./deployment/overview): where route-auth secrets live in production
