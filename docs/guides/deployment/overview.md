---
title: "Overview"
description: "Choose a deployment strategy and prepare an eve agent for production."
---

Deploy eve to Vercel or run it as a Node service on your own infrastructure. Your deployment strategy determines the build output, workflow storage, sandbox backend, and routing. The agent’s filesystem-based configuration remains portable across these strategies.

## Choose a deployment strategy

Each strategy changes the runtime services around your agent, not the files that define it:

| Strategy                               | Web runtime                   | Workflow state                     | Sandbox                            | Choose it when                                   |
| -------------------------------------- | ----------------------------- | ---------------------------------- | ---------------------------------- | ------------------------------------------------ |
| [Vercel](./vercel)                     | Vercel Build Output           | Vercel Workflow                    | Vercel Sandbox                     | You want eve’s managed platform integration      |
| [Self-hosting](./self-hosting)         | Nitro Node server             | Local or custom Workflow world     | Docker, microsandbox, or custom    | You operate a Node service or container platform |
| [Host framework](../frontend/overview) | Integrated or proxied service | Depends on the deployment platform | Depends on the deployment platform | Your agent runs alongside a web application      |

Host framework integration and deployment platform are separate choices. For example, a Next.js application can include an eve agent and deploy both services to Vercel.

## Meet the production requirements

Every production deployment must satisfy the same runtime requirements:

1. Run `eve build` to compile the agent and create host output.
2. Provide a model credential and any secrets required by tools, connections, and route authentication.
3. Replace `placeholderAuth()` with a production route policy before accepting browser traffic.
4. Select workflow and sandbox implementations that match the host.
5. Expose eve’s web routes and workflow callback route.
6. Verify the health route and complete a real agent turn.

`eve build` always writes compiler artifacts under `.eve/`. A Vercel build also writes `.vercel/output`. A build for another host writes the standard Nitro server under `.output/`.

## Configure runtime credentials

Keep credentials in your deployment environment or secret manager. Don’t include them in source or compiled artifacts.

Your model configuration determines the required credential. A string model ID uses the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) and requires Vercel project OpenID Connect (OIDC) or `AI_GATEWAY_API_KEY`. A provider-authored model uses that provider’s package and API key. See [Agent configuration](../../agent-config#model) for both forms.

Configure production route authentication separately from model access. The default policy rejects browser traffic in production. See [Auth and route protection](../auth-and-route-protection) for the available policies and secret requirements.

## Preserve the runtime routes

Every deployment serves agent routes under `/eve/`. Workflow implementations also send callbacks to `/.well-known/workflow/`.

Managed integrations configure these routes for you. If you add a reverse proxy or ingress, forward both prefixes to eve. Forwarding only `/eve/` lets sessions start, but prevents workflow callbacks from resuming them.

## Verify the deployment

Check the public health route first:

```bash
curl https://your_agent.example.com/eve/v1/health
```

Then connect the development terminal user interface (TUI) to the deployment and send a real message:

```bash
eve dev https://your_agent.example.com
```

Set `VERCEL_AUTOMATION_BYPASS_SECRET` locally first if a Vercel deployment uses Deployment Protection.

## Continue with a platform guide

Follow the guide for your deployment platform or application topology:

- [Deploy to Vercel](./vercel): use Vercel Build Output, Workflow, Sandbox, Cron, and observability
- [Self-host eve](./self-hosting): run the Nitro Node server with infrastructure you manage
- [Frontend integrations](../frontend/overview): mount eve alongside Next.js, Nuxt, or SvelteKit
