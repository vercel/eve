# Mem0 eve template

An [eve](https://eve.dev) agent template with long-term memory powered by
[Mem0](https://mem0.ai). eve is Vercel's framework for durable backend AI agents;
this template wires Mem0 into an eve agent so it remembers facts and preferences
about each user across conversations, getting more helpful over time instead of
starting from scratch.

## Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/mem0ai/mem0-eve-template&project-name=mem0-eve-template&repository-name=mem0-eve-template&integration-ids=oac_rTG82TypBWqzWTr1IpOUG7EB)

Deploy clones this repo and installs the Mem0 integration, which sets `MEM0_API_KEY`
on your project automatically. Model access uses the Vercel AI Gateway through your
linked project.

## How it works

The agent has two Mem0-backed tools:

- **`remember`** — saves a durable fact or preference (`mem0.add`).
- **`recall_memories`** — searches long-term memory for relevant facts (`mem0.search`).

The instructions (`agent/instructions.md`) tell the model to recall before answering
and to remember durable facts. Memory is scoped per user via
`ctx.session.auth.current.principalId` (see `agent/lib/mem0.ts`).

## Auth

The chat channel (`agent/channels/eve.ts`) ships with `placeholderAuth()`, the
safe default: local development works, your own Vercel deployments and the eve
TUI can reach the agent, and anonymous browser traffic is blocked in production.

Add your auth provider (Auth.js, Clerk, `vercelOidc()`) to open it to real
users. Memory is scoped per authenticated user via `principalId`, so each user
gets their own memory automatically once a provider is in place. For a throwaway
public demo where everyone shares one memory, swap `placeholderAuth()` for
`none()`.

## Run locally

```bash
npm install
vercel env pull            # pulls MEM0_API_KEY from your Vercel project
# set AI_GATEWAY_API_KEY, or link a Vercel project for model access
npm run dev                # opens the eve development REPL
```

Try it: tell the agent something ("I'm vegetarian and allergic to nuts"), start a
new session, and ask "what can I eat?" — it recalls what you told it.

## Learn more

- [Mem0 on Vercel](https://docs.mem0.ai/integrations/vercel)
- [Mem0 quickstart](https://docs.mem0.ai/platform/quickstart)
- [eve documentation](https://eve.dev/docs)

## License

Apache-2.0. See [LICENSE](./LICENSE).
