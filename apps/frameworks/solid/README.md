# Solid with eve demo

A Solid 2 app in SSR start mode with an embedded eve agent, integrated through
the `eveVite()` Vite plugin and deployed with Nitro:

```ts
import solid from "@solidjs/vite-plugin";
import { eveVite } from "eve/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  plugins: [solid({ start: true, ssr: true }), nitro(), eveVite()],
});
```

The agent lives in `agent/` (instructions, tools, channels), and
`src/App.tsx` renders the conversation with `useEveAgent` from `eve/solid`.

## Run locally

```sh
pnpm --filter framework-solid dev
```

## Deploy

On Vercel, `nitro()` writes the app's Build Output and `eveVite()` adds the
eve service and route to it. See
[the Vite frontend docs](../../../docs/guides/frontend/vite.mdx) for details.
