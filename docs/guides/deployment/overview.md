---
title: "Overview"
description: "Choose a deployment strategy and prepare an eve agent for production."
---

Deploy eve to Vercel or run it as a Node service on your own infrastructure. The strategy determines the build output, workflow storage, sandbox provider, and routing; the agent directory stays the same.

## Choose a deployment strategy

| Strategy                       | Build output           | Workflows                      | Sandbox          | Choose it when                                        |
| ------------------------------ | ---------------------- | ------------------------------ | ---------------- | ----------------------------------------------------- |
| [Vercel](./vercel)             | `.vercel/output`       | Vercel Workflow                | Vercel Sandbox   | You want Vercel to operate the runtime services       |
| [Self-hosting](./self-hosting) | `.output/` Node server | Local or custom Workflow world | Docker or custom | You operate your own Node or container infrastructure |

You can also deploy eve inside a Next.js, Nuxt, SvelteKit, or TanStack Start application. See [Frontend integrations](../frontend/overview).

## Prepare for production

Every production deployment needs these steps:

1. Run `eve build` to compile the agent and create host output.
2. Provide a model credential and any secrets required by tools, connections, and route authentication.
3. Replace `placeholderAuth()` with a production route policy before accepting browser traffic.
4. Select workflow and sandbox implementations that match the host.
5. Verify the health route and complete a real agent turn.

`eve build` always writes compiler artifacts under `.eve/`. A Vercel build also writes `.vercel/output`. A build for another host writes the standard Nitro server under `.output/`.

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
- [Self-host eve](./self-hosting): run the Nitro Node server with infrastructure you manage
- [Frontend integrations](../frontend/overview): mount eve alongside Next.js, Nuxt, SvelteKit, or TanStack Start
