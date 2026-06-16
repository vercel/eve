---
title: "Deployment"
description: "A production checklist for shipping an Eve agent on Vercel, covering build output, env and secrets, sandbox backend, prewarm, auth, deploy, and verify."
---

Eve runs the same way locally and on Vercel, so taking an agent from `eve dev` to production is mostly mechanical. Work through this checklist in order.

## 1. Build

`eve build` compiles the agent and writes the host output:

```bash
eve build
```

When `VERCEL` is set (every hosted Vercel build sets it), `eve build` writes the Vercel output bundle under `.vercel/output`. A plain local `eve build` skips that bundle. Either way you get Eve's compiled framework artifacts under `.eve/`, including the discovery manifest, compiled manifest, diagnostics, and module map. Open those to see which authored surface a deployment will load. For the artifact guide and what to do when `eve build` fails, see [Observability](./instrumentation).

## 2. Environment variables and secrets

Set these in your Vercel project's environment variables, never in source or compiled artifacts:

- **A model credential.** The lowest-setup option is the Vercel AI Gateway. Link a Vercel project, and gateway model ids like `anthropic/claude-opus-4.8` authenticate through Vercel OIDC, with no provider keys to manage. To call a provider directly instead, set its key (for example `OPENAI_API_KEY`).
- **Route-auth secrets**, for example `ROUTE_AUTH_BASIC_PASSWORD` and any JWT/OIDC signing keys referenced by your channel's `auth` (see [Auth and route protection](./auth-and-route-protection)).

Route-auth secrets are never serialized into the compiled discovery or module-map artifacts. The runtime re-materializes them from the authored channel definition instead. If your deployment sits behind Vercel preview protection and you want to drive it with `eve dev`, set `VERCEL_AUTOMATION_BYPASS_SECRET` locally before launching.

## 3. Sandbox backend

On Vercel, the [sandbox](../sandbox) runs on hosted [Vercel Sandbox](https://vercel.com/docs/sandbox) infrastructure. Attach the backend on the sandbox definition:

```ts title="agent/sandbox/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: vercel(),
});
```

Leave `backend` off and Eve falls back to `defaultBackend()`, which picks the Vercel backend on hosted builds and the local backend everywhere else. One definition, both environments.

## 4. Build-time sandbox prewarm

During hosted builds, Eve prewarms reusable Vercel sandbox templates so the first session doesn't pay the cold-start cost:

- Prewarm runs only when both `VERCEL` and `VERCEL_DEPLOYMENT_ID` are present.
- A sandbox with no `bootstrap()` and no workspace seed files gets skipped.
- Seed-only templates are keyed by skills and workspace file contents, so unchanged seeds reuse a template across deploys.
- Templates with a `bootstrap()` are keyed by the optional resolved `revalidationKey()` plus the authored sandbox source and seed contents, so matching inputs reuse a template across deploys.
- Each template shows up in the build log as either `reused cached` or `built`.
- Prewarming only covers template construction. `onSession()` still runs at runtime, once per session.
- **If build-time prewarm fails, the build fails.**

## 5. Auth

Swap any scaffolded `placeholderAuth()` for your real policy before the first production browser request hits the app. Both the framework default and the placeholder reject production browser traffic, so an unconfigured app fails closed rather than serving open routes. See [Auth and route protection](./auth-and-route-protection) for the ordered auth walk and the fail-closed guarantee.

## 6. Deploy on Vercel

Deploy with the [Vercel CLI](https://vercel.com/docs/cli) or by pushing to a Git-connected project:

```bash
vercel deploy
```

The deployed app serves the same stable health, session, and stream routes you've been hitting locally.

## 7. Verify the deployment

Smoke-test the live routes. Health first:

```bash
curl https://<your-app>/eve/v1/health
```

Then a real turn:

```bash
curl -X POST https://<your-app>/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Hello from production"}'
```

The POST returns a JSON body whose `sessionId` identifies the new session. Attach to that session's stream with it:

```bash
curl https://<your-app>/eve/v1/session/<sessionId>/stream
```

Or drive the deployment interactively with the dev TUI, which is handy for preview and production smoke tests:

```bash
eve dev https://<your-app>
```

(Set `VERCEL_AUTOMATION_BYPASS_SECRET` locally first if the deployment uses preview protection.)

## View runs in the dashboard

Once the agent is deployed, the platform auto-detects `eve` as the framework and surfaces an **Agent Runs** tab under your project's **Observability** view in the Vercel dashboard. From there you can browse sessions and drill into each conversation's trace.

> The Agent Runs tab is currently gated. Your Vercel team needs the feature enabled before it appears. If you don't see it, reach out to your Vercel contact to get your team enabled.

Agent Runs is separate from the OpenTelemetry exporters configured in [Observability](./instrumentation). Those still work and are the recommended path if you want spans in Braintrust, Datadog, or another third-party backend.

## How Eve sits behind a host framework

You can deploy an Eve app on its own, or mount it inside a host web framework that owns the rest of the site (marketing pages, a dashboard, other API routes). The host keeps its own routing and serves Eve's routes through the framework integration. Either way, the agent surface and HTTP contract are identical. For mounting Eve in Next.js (`withEve`) and the other supported frameworks, see [Frontend](./frontend/nextjs).

## Checklist

- [ ] `eve build` succeeds, and writes `.vercel/output` when `VERCEL` is set.
- [ ] Provider keys and route-auth secrets are set in Vercel env vars.
- [ ] The sandbox backend matches the environment (`vercel()` or `defaultBackend()`).
- [ ] Build-time prewarm reused or built templates without failing.
- [ ] `placeholderAuth()` is replaced with your real policy.
- [ ] `vercel deploy` succeeds.
- [ ] The health, session, and stream routes respond on the deployment URL.

## What to read next

- [Auth and route protection](./auth-and-route-protection): secure the routes you deployed
- [Observability](./instrumentation): tracing, run tags, and common failures
- [Sandbox](../sandbox): backends, lifecycle, and credential brokering
