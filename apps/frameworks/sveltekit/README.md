# SvelteKit with Eve demo

A SvelteKit app with an embedded Eve agent, integrated through the
`eveSvelteKit()` Vite plugin:

```ts
import { eveSvelteKit } from "eve/sveltekit";

export default defineConfig({
  plugins: [eveSvelteKit(), sveltekit()],
});
```

The agent lives in `agent/` (instructions, tools, channels). The UI in
`src/lib/` is a small agent console built on Eve's Svelte hooks, with
streaming, reasoning, and tool-call rendering.

## Run locally

```sh
pnpm --filter framework-sveltekit dev
```

## Deploy

`vercel.json` declares two services: the SvelteKit app at `/` and Eve behind
the private `/_eve_internal/eve` service prefix, with rewrites exposing the
public `/eve/v1/*` endpoints. See
[the SvelteKit frontend docs](../../../docs/guides/frontend/sveltekit.mdx) for
details.
