---
title: "Overview"
description: "How an eve agent runs in production, and the backends you choose on Vercel or your own infrastructure."
---

Deploy eve to Vercel or run it as a Node service on your own infrastructure. Both targets run on the open-source [Workflow SDK](https://workflow-sdk.dev/), so conversations, approvals, and subagent work survive restarts and long waits. The agent directory stays the same on every target.

## Choose a deployment target

| Target                         | Build output           | Choose it when                                                  |
| ------------------------------ | ---------------------- | --------------------------------------------------------------- |
| [Vercel](./vercel)             | `.vercel/output`       | You want Vercel to operate the runtime services                 |
| [Self-hosting](./self-hosting) | `.output/` Node server | You run Node services on your own servers or container platform |

You can also deploy eve beside a Next.js, Nuxt, SvelteKit, or TanStack Start application that routes browser requests to the agent. See [Frontend integrations](../frontend/overview).

## Backends

The eve server hands storage, isolation, model access, scheduling, and tracing to backends. Each deployment target picks a default for every backend, so a new agent deploys without backend configuration.

| Backend          | What it does                                                        | On Vercel                                    | Self-hosted                                                    |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Workflow world   | Stores sessions, queues their work, and resumes them after restarts | Vercel Workflow                              | [Local, Postgres, or another world package](./workflow-worlds) |
| Sandbox provider | Runs the `bash`, `read_file`, and `write_file` tools                | Vercel Sandbox                               | Docker by default, or another [provider](../../sandbox)        |
| Model access     | Sends model calls                                                   | AI Gateway via OIDC                          | AI Gateway API key or an AI SDK provider package               |
| Schedules        | Runs authored [schedules](../../schedules)                          | Vercel Cron                                  | The schedule runner in `eve start`                             |
| Observability    | Records traces of sessions, turns, and tool calls                   | [Agent Runs](../../observability/agent-runs) | [OpenTelemetry](../../observability/otel)                      |

Self-hosted defaults store workflow state on disk, and run sandboxes in Docker when Docker is available during the build. See [Self-host eve](./self-hosting) for the persistent storage and sandbox setup your host must provide.

## Prepare for production

Every production deployment needs these steps:

1. Run `eve build` to compile the agent and create host output.
2. Provide a model credential and any secrets required by tools, connections, and route authentication.
3. Replace `placeholderAuth()` with a production route policy before accepting browser traffic.
4. Verify the health route and complete a real agent turn.

`eve build` always writes compiler artifacts under `.eve/`. A Vercel build also writes `.vercel/output`. A build for another host writes the eve server under `.output/`.

## Configure credentials

Keep credentials in your deployment environment or secret manager, not in source or compiled artifacts.

Your model configuration determines the required credential. A string model ID uses the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) and requires Vercel project OpenID Connect (OIDC) or `AI_GATEWAY_API_KEY`. A provider-authored model uses that provider’s package and API key. See [Agent configuration](../../agent-config#set-the-model) for both forms.

Route authentication is separate from model access. The default policy rejects browser traffic in production. See [Authentication](../auth-and-route-protection) for the available policies and secret requirements.

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

- [Deploy to Vercel](./vercel): use Vercel Build Output, Workflow, Sandbox, Cron, and observability
- [Self-host eve](./self-hosting): run the eve server on Node with backends you choose
- [Frontend integrations](../frontend/overview): mount eve alongside Next.js, Nuxt, SvelteKit, or TanStack Start
