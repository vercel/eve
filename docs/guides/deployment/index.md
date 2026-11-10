---
title: "Deployment"
description: "How an eve agent runs in production, and the backends you choose on Vercel or your own infrastructure."
---

Deploy eve to Vercel or run it as a Node service on your own infrastructure. Both targets run on the open-source [Workflow SDK](https://workflow-sdk.dev/), so conversations, approvals, and subagent work survive restarts and long waits. The agent directory stays the same on every target.

## Choose a deployment target

| Target                                               | Build output           | Choose it when                                                  |
| ---------------------------------------------------- | ---------------------- | --------------------------------------------------------------- |
| [Vercel](/docs/guides/deployment/vercel)             | `.vercel/output`       | You want Vercel to operate the runtime services                 |
| [Self-hosting](/docs/guides/deployment/self-hosting) | `.output/` Node server | You run Node services on your own servers or container platform |

You can also deploy eve beside a Next.js, Nuxt, SvelteKit, TanStack Start, or other Vite application that routes browser requests to the agent. See [Frontend integrations](/docs/guides/frontend).

## Backends

The eve server hands storage, isolation, model access, scheduling, and tracing to backends. Each deployment target picks a default for every backend, so a new agent deploys without backend configuration.

| Backend          | What it does                                                        | On Vercel                                    | Self-hosted                                                                          |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| Workflow world   | Stores sessions, queues their work, and resumes them after restarts | Vercel Workflow                              | [Local, Postgres, or another world package](/docs/guides/deployment/workflow-worlds) |
| Sandbox provider | Runs the `bash`, `read_file`, `write_file`, and `edit_file` tools   | Vercel Sandbox                               | Docker by default, or another [provider](/docs/sandbox)                              |
| Model access     | Sends model calls                                                   | AI Gateway via OIDC                          | AI Gateway API key or an AI SDK provider package                                     |
| Schedules        | Runs authored [schedules](/docs/schedules)                          | Vercel Cron                                  | The schedule runner in `eve start`                                                   |
| Observability    | Records traces of sessions, turns, and tool calls                   | [Agent Runs](/docs/observability/agent-runs) | [OpenTelemetry](/docs/observability/otel)                                            |

Self-hosted defaults store workflow state on disk, and run sandboxes in Docker when Docker is available during the build. See [Self-host eve](/docs/guides/deployment/self-hosting) for the persistent storage and sandbox setup your host must provide.

## Prepare for production

Every production deployment needs these steps:

1. Run `eve build` to compile the agent and create host output.
2. Provide a model credential and any secrets required by tools, connections, and route authentication.
3. Replace `placeholderAuth()` with a production route policy before accepting browser traffic.
4. Verify the health route and complete a real agent turn.
5. Check that the bundle stays small. See [Keep the bundle small](#keep-the-bundle-small).

`eve build` always writes compiler artifacts under `.eve/`. A Vercel build also writes `.vercel/output`. A build for another host writes the eve server under `.output/`.

Files in a `public/` directory at the app root are copied into the build output, and eve's host serves them as static files.

## Keep the bundle small

Each file under `agent/`, and everything it imports, ships in the deployed function. That code also runs when an instance starts, even when the invocation does not use it.

- **Import heavy SDKs where you use them.** Load database, auth, cache, and cloud SDK clients with `await import()` in the tool, hook, or helper that calls them, not at the top of the file.
- **Keep shared modules light.** A module that many tools, hooks, or instrumentation files import adds its imports to all of them.
- **Use one version of each dependency.** Two versions of the same package ship and load twice. Align versions across your app's packages, and check with `pnpm why <package>`.
- **Keep instrumentation lean.** eve loads instrumentation files first and bundles each one separately, so keep their imports small. Enable only the OpenTelemetry instrumentations you use, and import exporters that only development or evals use with `await import()`.
- **Do no work at module scope.** Create clients, formatters, and other objects on first use, not when the module loads.

Loading on first use moves the cost to the first call that needs it. It helps most for code that only some invocations reach.

## Configure credentials

Keep credentials in your deployment environment or secret manager, not in source or compiled artifacts.

Your model configuration determines the required credential. A string model ID uses the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) and requires Vercel project OpenID Connect (OIDC) or `AI_GATEWAY_API_KEY`. A provider-authored model uses that provider’s package and API key. See [Agent configuration](/docs/agent-config#set-the-model) for both forms.

Route authentication is separate from model access. The default policy rejects browser traffic in production. See [Authentication](/docs/guides/auth-and-route-protection) for the available policies and secret requirements.

## Verify the deployment

Check the public health route first:

```bash
curl https://your_agent.example.com/eve/v1/health
```

Then connect the development terminal user interface (TUI) to the deployment and send a real message:

```bash
eve remote connect --url https://your_agent.example.com
```

Set `VERCEL_AUTOMATION_BYPASS_SECRET` locally first if a Vercel deployment uses Deployment Protection.

## Continue with a platform guide

- [Deploy to Vercel](/docs/guides/deployment/vercel): use Vercel Build Output, Workflow, Sandbox, Cron, and observability
- [Self-host eve](/docs/guides/deployment/self-hosting): run the eve server on Node with backends you choose
- [Frontend integrations](/docs/guides/frontend): mount eve alongside Next.js, Nuxt, SvelteKit, TanStack Start, or another Vite app
