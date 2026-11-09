# Vite with eve demo

A Vite React app with an embedded eve agent, integrated through the
`eveVite()` Vite plugin:

```ts
import { eveVite } from "eve/vite";

export default defineConfig({
  plugins: [react(), eveVite()],
});
```

The agent lives in `agent/` (instructions, tools, channels).

## Run locally

```sh
pnpm --filter framework-vite dev
```

## Deploy

A plain Vite app has no adapter that writes Vercel's Build Output during
`vite build`, so compose the agents in `vercel.ts` with `withEve` from
`eve/vercel`. See [the Vite frontend docs](../../../docs/guides/frontend/vite.mdx) for details.
