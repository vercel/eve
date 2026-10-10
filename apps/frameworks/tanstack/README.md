# TanStack Start with eve demo

A TanStack Start app with an embedded eve agent, integrated through the
`eveTanStack()` Vite plugin:

```ts
import { eveTanStack } from "eve/tanstack";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [eveTanStack(), tanstackStart(), viteReact(), nitro()],
});
```

The agent lives in `agent/` (instructions, tools, channels). The UI in
`src/components/` is a small agent console built on eve's React hook, with
streaming, reasoning, and tool-call rendering.

## Run locally

```sh
pnpm --filter framework-tanstack dev
```

## Deploy

On Vercel builds the plugin generates the eve service and its routing in the
Build Output config, so no `vercel.json` is required. See
[the TanStack Start frontend docs](../../../docs/guides/frontend/tanstack.mdx) for details.
