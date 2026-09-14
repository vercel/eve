# Next.js multi-agent eve demo

This app demonstrates `withEve()` discovering three independent eve agents
from the project-level `agents/` workspace and mounting them into one Next.js app:

- `support` at `/eve/agents/support/eve/v1/*`
- `billing` at `/eve/agents/billing/eve/v1/*`
- `research` at `/eve/agents/research/eve/v1/*`

Run it locally with:

```sh
pnpm --filter framework-next-multi-agent dev
```

The page calls each agent with `useEveAgent({ agent: "<name>" })`.
