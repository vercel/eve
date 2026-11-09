import type { Plugin } from "vite";

import { createEveVitePlugin, type EveVitePluginOptions } from "#shared/vite-eve-plugin.js";

export type { EveVitePluginOptions };

/**
 * Vite plugin for running eve agents alongside any Vite app.
 *
 * In development and `vite preview`, proxies each agent's protocol endpoints
 * to a local eve server: `/eve/v1/*` for a single agent, or
 * `/eve/<name>/v1/*` for each member of an `agents/` workspace. It resolves
 * each server in order: the `EVE_BASE_URL` env var if set, then a healthy
 * shared eve dev server already running for the agent, then a freshly spawned
 * `eve dev --no-ui --port 0`. Servers spawned by the plugin stop when the
 * Vite server closes. Apps served by Nitro get the same proxies as Nitro
 * route rules.
 *
 * On Vercel builds, adds each agent as a sibling Vercel service in the
 * `.vercel/output` the app's framework, adapter, or Nitro writes, and routes
 * its transport requests before the app's own routing. A `vercel.json` with
 * services, or a `vercel.ts` that composes `withEve` from `eve/vercel`, owns
 * the services instead.
 */
export function eveVite(options: EveVitePluginOptions = {}): Plugin {
  return createEveVitePlugin({ host: { label: "Vite", slug: "vite" }, options });
}
