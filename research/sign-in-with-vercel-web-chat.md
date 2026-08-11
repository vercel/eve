---
issue: https://github.com/vercel/eve/issues/1953
status: proposed
last_updated: "2026-08-11"
---

# Sign in with Vercel for Web Chat

## Problem

The default Web Chat scaffold intentionally fails closed with `placeholderAuth()`. Product surfaces that already provision a private Vercel App need a supported way to generate a usable, team-scoped Web Chat without maintaining a second copy of the app template.

## Authoring contract

Callers may request an authenticated Web Chat explicitly:

```ts
await ensureChannel({
  kind: "web",
  projectRoot,
  webAuthentication: "sign-in-with-vercel",
});
```

Omitting `webAuthentication` preserves the existing scaffold exactly. The option adds Better Auth's Vercel provider, protects the production page and eve channel with the same verified session, and keeps `localDev()` for local development.

The authenticated variant defaults to stable Next.js `16.3.0`. The base scaffold currently follows a prerelease Next.js line that does not satisfy Better Auth's peer dependency; callers may still provide a compatible `webPackageVersions.nextPackageVersion` explicitly.

## Ownership boundary

Eve owns the generated application code and conditional `better-auth` dependency. The caller owns control-plane provisioning:

- create the Vercel App and client secret;
- configure `signInFrom: "owning-team"` when team-only access is required;
- register `/api/auth/callback/vercel` for the generated project;
- provide `VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET`, and `BETTER_AUTH_SECRET`.

This boundary keeps internal Vercel APIs and credentials out of Eve while making the generated application portable.

## Security semantics

- Production fails closed when credentials are missing.
- Better Auth validates the OAuth callback and session before Eve receives a user principal.
- The channel accepts the Better Auth session, Vercel service-to-service OIDC, or localhost development auth.
- Dynamic base URL discovery trusts the current Vercel deployment hosts, with a `*.vercel.app` fallback for generated preview deployments.

## Non-goals

- Exposing OAuth App provisioning from Eve.
- Adding a CLI prompt before the first programmatic consumer is validated.
- Changing the default Web Chat authentication behavior.
