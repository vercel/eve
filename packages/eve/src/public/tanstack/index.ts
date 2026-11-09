import type { Plugin } from "vite";

import { createEveVitePlugin, type EveVitePluginOptions } from "#shared/vite-eve-plugin.js";

/**
 * Options for the eve TanStack Start Vite plugin.
 */
export type EveTanStackPluginOptions = EveVitePluginOptions;

/**
 * Vite plugin for running eve agents alongside a TanStack Start app.
 *
 * TanStack Start reaches Vercel through Nitro, so the app must register
 * `nitro()` from `nitro/vite`; `eveTanStack` configures Nitro to route eve.
 *
 * In development, Nitro proxies eve protocol endpoints to a local eve server:
 * `/eve/v1/*` for a single agent, or `/eve/<name>/v1/*` for each member of an
 * `agents/` workspace. It resolves each server in order: the `EVE_BASE_URL`
 * env var if set, then a healthy shared eve dev server already running for
 * the agent, then a freshly spawned `eve dev --no-ui --port 0`. Servers
 * spawned by the plugin stop when the Vite dev server closes.
 *
 * On Vercel builds, `eveTanStack` adds each agent as a sibling Vercel service
 * and routes its transport requests before TanStack Start's own routing,
 * including routes declared in `nitro({ vercel: { config } })`.
 */
export function eveTanStack(options: EveTanStackPluginOptions = {}): Plugin {
  return createEveVitePlugin({
    host: { label: "TanStack Start", slug: "tanstack" },
    nitroOnly: true,
    options,
  });
}
