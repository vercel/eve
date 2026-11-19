import type { Plugin } from "vite";

import { createEveVitePlugin, type EveVitePluginOptions } from "#shared/vite-eve-plugin.js";

/**
 * Options for the eve SvelteKit Vite plugin.
 */
export type EveSvelteKitPluginOptions = EveVitePluginOptions;

/**
 * Vite plugin for running eve agents alongside a SvelteKit app.
 *
 * In development and local preview, `eveSvelteKit` proxies eve protocol
 * endpoints to a local eve server: `/eve/v1/*` for a single agent, or
 * `/eve/<name>/v1/*` for each member of an `agents/` workspace. It resolves
 * each server in order: the `EVE_BASE_URL` env var if set, then a healthy
 * shared eve dev server already running for the agent, then a freshly spawned
 * `eve dev --no-ui --port 0`. Servers spawned by the plugin stop when the
 * Vite server closes.
 *
 * On Vercel builds, `eveSvelteKit` adds each agent as a sibling Vercel
 * service and routes its transport requests before SvelteKit filesystem
 * routing.
 */
export function eveSvelteKit(options: EveSvelteKitPluginOptions = {}): Plugin {
  return createEveVitePlugin({
    host: { label: "SvelteKit", slug: "sveltekit" },
    options,
    vercelOutputAfterSsrBundle: true,
  });
}
