---
title: "Deployment"
description: "A production checklist for shipping an eve agent on Vercel or your own host, covering build output, env and secrets, sandbox backend, auth, deploy, and verify."
---

eve runs the same way locally, on Vercel, and on a long-running Node host, so taking an agent from `eve dev` to production is mostly mechanical. Work through this checklist in order.

## 1. Build

`eve build` compiles the agent and writes the host output:

```bash
eve build
```

When `VERCEL` is set (every hosted Vercel build sets it), `eve build` writes the [Vercel Build Output](https://vercel.com/docs/build-output-api) bundle under `.vercel/output`. A plain local `eve build` skips that bundle. Either way you get eve's compiled framework artifacts under `.eve/`, including the discovery manifest, compiled manifest, diagnostics, and module map. Open those to see which authored surface a deployment will load. For the artifact guide and what to do when `eve build` fails, see [Observability](./instrumentation).

### How portability works

Nitro is the HTTP host layer. It gives eve a build artifact that can serve the health, session, stream, channel, callback, and schedule routes outside the dev server. Workflow execution and sandbox execution are separate runtime adapters; they are not hidden Vercel dependencies inside Nitro.

On Vercel, eve emits Vercel Build Output, the Workflow SDK runs on Vercel Workflow, and `defaultBackend()` selects Vercel Sandbox. Outside Vercel, `eve start` serves the standard Nitro Node output, the Workflow SDK uses its local world by default, and `defaultBackend()` selects a local sandbox backend in availability order. That local workflow world persists run state on disk and has no direct coupling to Vercel; Vercel-only behavior such as latest-deployment routing and dashboard run attributes is additive.

Eve does not expose Workflow world selection as a public app API today. Future releases will let advanced deployments provide a different Workflow world, the SDK abstraction for workflow state, queues, auth, and streaming; see [Workflow Worlds](https://workflow-sdk.dev/worlds) for the underlying concept.

## 2. Environment variables and secrets

Set these in your deployment environment or secret manager, never in source or compiled artifacts:

- **A model credential.** The lowest-setup Vercel option is the Vercel AI Gateway. Link a Vercel project, and gateway model ids like `anthropic/claude-opus-4.8` authenticate through Vercel OIDC, with no provider keys to manage. Outside Vercel, either set `AI_GATEWAY_API_KEY` for gateway-routed models or configure a direct provider model with an [AI SDK provider package](https://ai-sdk.dev/docs/foundations/providers-and-models) and set that provider's key, for example `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- **Route-auth secrets**, for example `ROUTE_AUTH_BASIC_PASSWORD` and any JWT/OIDC signing keys referenced by your channel's `auth` (see [Auth and route protection](./auth-and-route-protection)).

Route-auth secrets are never serialized into the compiled discovery or module-map artifacts. The runtime re-materializes them from the authored channel definition instead. If your deployment sits behind Vercel preview protection and you want to drive it with `eve dev`, set `VERCEL_AUTOMATION_BYPASS_SECRET` locally before launching.

## 3. Model routing

The shape of `model` in `agent/agent.ts` decides whether eve calls the Vercel AI Gateway or a provider endpoint directly.

A string model id is gateway-routed:

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "anthropic/claude-opus-4.8",
});
```

That works on Vercel with project OIDC or anywhere else with `AI_GATEWAY_API_KEY`. Passing a provider key through `modelOptions.providerOptions.gateway.byok` also still sends the request through the Gateway; it only changes which upstream key the Gateway uses.

To avoid the Gateway entirely, install the [AI SDK package](https://ai-sdk.dev/docs/foundations/providers-and-models) for the provider you want to call, pass that provider's model object, and set that provider's normal environment variable:

```bash
npm install @ai-sdk/anthropic
```

```ts title="agent/agent.ts"
import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

export default defineAgent({
  model: anthropic("claude-opus-4.8"),
});
```

With that shape, the model call goes directly to Anthropic and the runtime reads `ANTHROPIC_API_KEY`. The same pattern works for OpenAI after installing `@ai-sdk/openai`, using `openai("...")`, and setting `OPENAI_API_KEY`. This is the usual choice when self-deploying without any Vercel-managed services.

## 4. Sandbox backend

On Vercel, the [sandbox](../sandbox) runs on hosted [Vercel Sandbox](https://vercel.com/docs/sandbox) infrastructure. Attach the backend on the sandbox definition:

```ts title="agent/sandbox/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

export default defineSandbox({
  backend: vercel(),
});
```

Leave `backend` off and eve falls back to `defaultBackend()`, which picks the Vercel backend on hosted builds and the local backend everywhere else. One definition, both environments.

For a self-deployed process, leave `defaultBackend()` in place or choose an explicit non-Vercel backend such as Docker or microsandbox. If those do not match your infrastructure, write a custom `SandboxBackend` adapter that creates sessions in your own container, VM, or isolation service. Do not pin `vercel()` unless that process should create hosted Vercel sandboxes.

## 5. Build-time sandbox prewarm

During hosted builds, eve prewarms reusable Vercel sandbox templates so the first session doesn't pay the cold-start cost:

- Prewarm runs only when both `VERCEL` and `VERCEL_DEPLOYMENT_ID` are present.
- A sandbox with no `bootstrap()` and no workspace seed files gets skipped.
- Seed-only templates are keyed by skills and workspace file contents, so unchanged seeds reuse a template across deploys.
- Templates with a `bootstrap()` are keyed by the optional resolved `revalidationKey()` plus the authored sandbox source and seed contents, so matching inputs reuse a template across deploys.
- Each template shows up in the build log as either `reused cached` or `built`.
- Prewarming only covers template construction. `onSession()` still runs at runtime, once per session.
- **If build-time prewarm fails, the build fails.**

If `VERCEL` is set but `VERCEL_DEPLOYMENT_ID` is missing, eve warns that it skipped prewarming. Do not deploy that build with `vercel deploy --prebuilt`; its output may reference sandbox templates that were never provisioned. Run `vercel deploy` instead so Vercel builds the source in its hosted build environment.

## 6. Auth

Swap any scaffolded `placeholderAuth()` for your real policy before the first production browser request hits the app. Both the framework default and the placeholder reject production browser traffic, so an unconfigured app fails closed rather than serving open routes. The production policy can be a shipped helper (`httpBasic()`, `jwtHmac()`, `jwtEcdsa()`, `oidc()`, `vercelOidc()`) or a custom `AuthFn` that validates your own sessions, API keys, or identity provider. See [Auth and route protection](./auth-and-route-protection) for the ordered auth walk and the fail-closed guarantee.

If you self-deploy outside Vercel, do not rely on `vercelOidc()` as the only production authenticator. Use your own route policy, such as Basic auth, JWT/OIDC verification for your identity provider, or a custom verifier.

## 7. Deploy on Vercel

Deploy with the [Vercel CLI](https://vercel.com/docs/cli) or by pushing to a Git-connected project:

```bash
vercel deploy
```

The deployed app serves the same stable health, session, and stream routes you've been hitting locally.

## 8. Deploy without Vercel

eve can also run as a normal Node service behind your own process manager, container platform, or reverse proxy:

```bash
eve build
PORT=3000 eve start --host 0.0.0.0
```

Eve writes the standard Nitro output under `.output/` instead of Vercel Build Output. `eve start` serves that built app and respects `PORT`, or the `--port` flag. Put TLS, routing, autoscaling, and log collection around that process the same way you would for any other Node HTTP service.

Self-deployed agents should make the Vercel-specific choices explicit:

- Let the Workflow SDK use its default local world, which stores workflow state under `.workflow-data`, or configure your host so that directory is on persistent storage.
- Install the AI SDK package for your provider, then use a direct provider model object and `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` when you want no Gateway dependency.
- Use `AI_GATEWAY_API_KEY` if you still want Gateway routing from a non-Vercel host.
- Replace `vercelOidc()` with auth that your host can verify.
- Use `defaultBackend()`, a pinned non-Vercel sandbox backend such as Docker or microsandbox, or your own `SandboxBackend` adapter.
- If the agent defines schedules, the default `eve build && eve start` path starts Nitro's schedule runner, and Vercel wires schedules to Vercel Cron automatically. If you adapt the output to a custom HTTP-only host or preset, make sure it also runs Nitro scheduled tasks, or trigger the same work from your own scheduler.
- Treat Vercel Cron, Vercel Sandbox prewarm, Vercel Deployment Protection bypass, and the Agent Runs dashboard as Vercel-only conveniences.

The HTTP contract is unchanged: health, session creation, streaming, channels, tools, and subagents use the same routes. Any client that can reach and authenticate to those routes can talk to the agent.

## 9. Verify the deployment

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

## How eve sits behind a host framework

You can deploy an eve app on its own, or mount it inside a host web framework that owns the rest of the site (marketing pages, a dashboard, other API routes). The host keeps its own routing and serves eve's routes through the framework integration. Either way, the agent surface and HTTP contract are identical. For mounting eve in Next.js (`withEve`) and the other supported frameworks, see [Frontend](./frontend/nextjs).

## Checklist

- [ ] `eve build` succeeds, and writes `.vercel/output` when `VERCEL` is set.
- [ ] Provider keys and route-auth secrets are set in the deployment environment.
- [ ] The sandbox backend matches the environment (`vercel()` or `defaultBackend()`).
- [ ] On Vercel, build-time prewarm reused or built templates without failing.
- [ ] `placeholderAuth()` is replaced with your real policy.
- [ ] `vercel deploy` succeeds, or your self-hosted process starts with `eve start`.
- [ ] The health, session, and stream routes respond on the deployment URL.

## What to read next

- [Auth and route protection](./auth-and-route-protection): secure the routes you deployed
- [Observability](./instrumentation): tracing, run tags, and common failures
- [Sandbox](../sandbox): backends, lifecycle, and credential brokering
