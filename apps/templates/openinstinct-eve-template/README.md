# Multi-tenant iMessage Assistant

Build an iMessage assistant service for multiple customers with eve and Linq. This starter adapts the agent configuration and iMessage channel from [Merit Systems' OpenInstinct](https://github.com/Merit-Systems/OpenInstinct), an application that connects users to their own assistant context and accounts.

The intended use case is one deployment serving multiple customers, rather than a separate deployment for each person's assistant. This starter provides the messaging foundation: it receives iMessage and SMS messages, derives sender identity from Linq, and replies through the same channel. Messages in the same Linq conversation continue the same eve session.

User enrollment and tenant-scoped resource access are not implemented. By default, every sender who reaches the connected line can run the agent and its default tools, with usage billed to your deployment. Add an admission policy before exposing the service to customers.

## Deploy with Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvercel%2Feve%2Ftree%2Fmain%2Fapps%2Ftemplates%2Fopeninstinct-eve-template&connect=%5B%7B%22type%22%3A%22linq%22%2C%22env%22%3A%22LINQ_CONNECTOR%22%2C%22triggers%22%3Atrue%2C%22triggerPath%22%3A%22%2Feve%2Fv1%2Flinq%22%7D%5D&project-name=openinstinct&repository-name=openinstinct)

The Vercel flow connects a Linq connector and configures the `/eve/v1/linq` trigger. Configure a model provider for eve in the project as well.

## Develop locally

Requirements: Node.js 24+ and pnpm.

```bash
pnpm install
vercel link
vercel env pull
pnpm dev
```

Edit `agent/agent.ts` and `agent/instructions.md` to configure the agent. The Linq channel is in `agent/channels/linq.ts`.

For local Linq testing, create or attach a Linq connector, set `LINQ_CONNECTOR` to its connector UID, and configure its trigger path as `/eve/v1/linq`. See the [Vercel Connect documentation](https://vercel.com/docs/connect) and the [eve Linq channel guide](https://eve.dev/docs/channels/linq).

## Add multi-tenant user scoping

A tenant is the customer account whose resources the agent can access. For an individual assistant service, each user can be a tenant. If your product supports shared workspaces, resolve both workspace membership and user identity.

Use `onMessage` in `agent/channels/linq.ts` to establish application identity before dispatching a message:

1. Look up the Linq sender in your application's enrolled users. Reject unknown or unauthorized senders by returning `null`.
2. Resolve the user's tenant from server-side membership records and return that identity in `auth`. Linq sender identity alone does not establish application membership.
3. Scope tools, memory, and connected credentials to that trusted identity. Never accept a tenant selection from the model or message text.
4. Authorize each resource access on the server. Separate conversations do not replace resource authorization.

Decide whether to support group conversations before enabling them; the default channel continues a session per conversation, not per individual sender. Add usage limits and review which default tools your service exposes.

See [Linq inbound dispatch](https://eve.dev/docs/channels/linq), [multi-tenant outbound auth](https://eve.dev/docs/patterns/multi-tenant-auth), and [multi-tenant memory](https://eve.dev/docs/patterns/multi-tenant-memory) for the relevant eve patterns.

## Scope and security

This starter does not include OpenInstinct's authenticated web application, encrypted vault, persistent memory, scheduling, user and workspace authorization, secure browser autofill, payment approval flow, or browser worker.

The sample instructions describe a messaging assistant and provide baseline model guidance. They do not enforce authorization or secret-handling controls. Implement and review those controls before connecting customer accounts, handling secrets, or enabling purchases.
