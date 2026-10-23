---
issue: https://github.com/vercel/eve/issues/4210
status: proposed
last_updated: "2026-10-23"
---

# Named agents in eve/nuxt and eve/sveltekit

## Problem

`withEve` in `eve/next` mounts several named agents under `/eve/<name>/v1/*`,
from an explicit `agents` map or from a discovered `agents/` workspace. The
browser bindings all accept `agent: "support"` and target those routes.
`eve/nuxt` and `eve/sveltekit` mount exactly one agent at `/eve/v1/**`, so
`useEveAgent({ agent })` has no route to talk to in a Nuxt or SvelteKit app,
and the option's documentation promises a capability two of the three
integrations do not have.

## Decision

Mount named agents in Nuxt and SvelteKit with the same authoring shape Next
already uses, and resolve the agent set in one shared module instead of three.

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["eve/nuxt"],
  eve: {
    agents: {
      billing: "../agents/billing",
      support: { root: "../agents/support", eveBuildCommand: "pnpm build:eve" },
    },
  },
});
```

```ts
// vite.config.ts
export default defineConfig({
  plugins: [eveSvelteKit({ agents: { billing: "../agents/billing" } }), sveltekit()],
});
```

Semantics match `eve/next`:

- A named agent serves `/eve/<name>/v1/**`; the unnamed single-agent form keeps
  `/eve/v1/**`.
- With no `agents` option, the integration discovers an `agents/` workspace at
  the host app root and mounts every member by its directory name.
- `agents` and `eveRoot` are mutually exclusive.
- On Vercel each agent becomes its own Build Output service with its own route.
- In development each agent gets its own shared eve dev server, spawned with
  `--agent <name>` for workspace members.
- In non-Vercel production each agent gets its own loopback port, offset from
  the base production port in declaration order, as Next does today.

## Architecture

The agent set is resolved once, by a host-neutral module that owns naming,
workspace discovery, route prefixes, service prefixes, and port offsets:

```
public/next/index.ts ─┐
public/nuxt/module.ts ├─> shared/framework-agents.ts ─> shared/vercel-services.ts
public/sveltekit/     ┘                               └> shared/framework-eve-server.ts
```

Each integration keeps only what its host makes it own: Next writes rewrites,
Nuxt writes Nitro route rules and its Vercel config merge, SvelteKit writes the
Vite proxy table and the `handle` hook forwarding introduced for #4211. Moving
resolution out of `public/next/index.ts` is a refactor of existing behavior,
so Next's current unit tests are the regression gate for it.

## Scope boundaries

- No change to the browser bindings. `agent` already produces the right URLs.
- No change to the eve server itself; this is host routing only.
- The `tanstack` integration stays single-agent until it has the same demand.

## Validation

- Unit coverage per integration for named route mounting, workspace discovery,
  Vercel service generation, and the `agents` plus `eveRoot` conflict.
- Framework fixtures: a `nuxt-multi-agent` app mirroring `next-multi-agent`,
  and a SvelteKit equivalent, both built in `test:framework-fixtures`.
- Docs: a multi-agent section in the Nuxt and SvelteKit guides, replacing the
  current "single agent only" note.
