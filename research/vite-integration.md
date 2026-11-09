---
issue: TBD
status: in-progress
last_updated: "2026-11-06"
---

# Generic Vite integration

eve has Vite plugins for SvelteKit and TanStack Start, but a Vite app without a dedicated integration has to start `eve dev`, proxy its routes, and wire Vercel services by hand. `eveVite()` from `eve/vite` does this for any Vite app.

```ts
import { eveVite } from "eve/vite";

export default defineConfig({
  plugins: [react(), eveVite()],
});
```

Options match the existing Vite plugins: `eveRoot`, `eveBuildCommand`, and `devServerTimeoutMs`.

## Semantics

- **Agents.** The eve project at `eveRoot` (default: the Vite root) mounts one agent at `/eve/v1/*`, or each `agents/` workspace member at `/eve/<name>/v1/*`, the same routes `eve/next` and `eve/vercel` use.
- **Dev and preview.** Each agent gets a shared eve dev server (`EVE_BASE_URL`, then a registered healthy server, then `eve dev --no-ui --port 0 [--agent <name>]`). The plugin adds `server.proxy` or `preview.proxy` entries that rewrite `/eve/<name>/v1` to `/eve/v1`. Nitro answers dev requests before Vite's proxy, so the plugin also writes the same proxies as Nitro route rules through the `nitro` config key; Vite ignores that key without Nitro. Spawned servers stop on `closeServer`.
- **Vercel.** When Nitro serves the app, the plugin's Nitro module merges each agent's generated service and routes into `nitro.options.vercel.config`, ahead of the user's own `nitro({ vercel })` routes. Otherwise it merges them into the `.vercel/output/config.json` the framework or adapter wrote, ahead of `handle: "filesystem"`: in `buildApp`, or, when the adapter writes that output as the SSR bundle closes (SvelteKit), in that build's `closeBundle`. A missing output fails the build with an actionable error. A `vercel.json` with services must include the eve services, and a `vercel.ts` that composes `withEve` from `eve/vercel` owns them, so the plugin writes nothing in either case.

## Boundaries

- Self-hosted production servers do not mount eve routes; the app forwards `/eve/` and `/.well-known/workflow/` itself or passes `baseUrl`.
- Without Nitro, the plugin reads `.vercel/output` instead of each framework's adapter API, so it works for any framework that writes Build Output during `vite build`.
- `eveSvelteKit()` and `eveTanStack()` keep their names and options and become thin wrappers over the same plugin. The Nuxt module reuses the same agent discovery, dev servers, and Vercel services. All three gain workspace agents; SvelteKit also gains `devServerTimeoutMs`. `eveTanStack()` still requires Nitro and leaves `vite preview` alone, because Nitro serves preview.
