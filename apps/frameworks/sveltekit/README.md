# SvelteKit with eve demo

A SvelteKit app with an embedded eve agent, integrated through the
`eveSvelteKit()` Vite plugin:

```ts
import { eveSvelteKit } from "eve/sveltekit";

export default defineConfig({
  plugins: [eveSvelteKit(), sveltekit()],
});
```

The agent lives in `agent/` (instructions, tools, channels). The UI in
`src/lib/` is a small agent console built on eve's Svelte hooks, with
streaming, reasoning, and tool-call rendering.

## Run locally

```sh
pnpm --filter framework-sveltekit dev
```

## Deploy

On Vercel builds the plugin generates the eve service and its routing in the
Build Output config, so no `vercel.json` is required. See
[the SvelteKit frontend docs](../../../docs/guides/frontend/sveltekit.mdx) for details.
