import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { addImports, defineNuxtModule, extendRouteRules } from "@nuxt/kit";

import type { VercelServicesConfig } from "#internal/vercel/vercel-services-config.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  addEveVercelServices,
  resolveEveAgentDevServer,
  resolveEveAgents,
} from "#shared/framework-eve-integration.js";
import { resolveDevServerTimeout, type EveFrameworkHost } from "#shared/framework-eve-server.js";

import { resolveProductionOrigin } from "./production-origin.js";

const EVE_NUXT_HOST: EveFrameworkHost = { label: "Nuxt", slug: "nuxt" };

/**
 * Options for the eve Nuxt module.
 */
export interface EveNuxtModuleOptions {
  /**
   * Maximum time in milliseconds to wait for each eve development server to
   * start, including waiting for another Nuxt process to start it. Defaults
   * to 180000 (three minutes).
   */
  devServerTimeoutMs?: number;
  /**
   * Path to the eve project root, resolved relative to the Nuxt project root
   * unless absolute. Defaults to the Nuxt project root. The root may contain
   * one `agent/` or an `agents/` workspace.
   */
  eveRoot?: string;
  /**
   * Command that builds each eve agent inside its generated Vercel service.
   * Defaults to running the installed eve binary from the agent root
   * (`node <path-to>/eve/bin/eve.js build`).
   */
  eveBuildCommand?: string;
}

/** Opaque setup entry consumed by Nuxt. Register it in `modules`, rather than invoking it directly. */
export interface EveNuxtModule {
  (options: EveNuxtModuleOptions, nuxt: object): void;
}

/**
 * Minimal view of the Nitro Vercel build-output config the module merges the
 * eve service into. The full `nitro` typing lives behind the nitropack/Nuxt
 * augmentation, which is not loaded in this package's build, so model only the
 * surface we touch.
 */
interface NitroVercelConfigHost {
  vercel?: {
    config?: VercelServicesConfig;
    [key: string]: unknown;
  };
}

/**
 * Nuxt module that wires eve agents into a Nuxt app. Register under `modules`
 * (configured via the `eve` config key). It auto-imports the `useEveAgent()`
 * composable and routes eve transport requests to the eve service: a shared
 * dev server spawned on demand in dev, a generated Vercel service on Vercel
 * deployments, and a configured origin/port in non-Vercel production. Requires
 * Nuxt >= 4.0.0. Configure via {@link EveNuxtModuleOptions}.
 */
const eveNuxtModule: EveNuxtModule = defineNuxtModule<EveNuxtModuleOptions>({
  meta: {
    name: "eve",
    configKey: "eve",
    compatibility: {
      nuxt: ">=4.0.0",
    },
  },
  defaults: {},
  async setup(options, nuxt) {
    const nuxtRoot = nuxt.options.rootDir;
    const devServerTimeoutMs = resolveDevServerTimeout(options.devServerTimeoutMs, EVE_NUXT_HOST);
    const agents = await resolveEveAgents(resolve(nuxtRoot, options.eveRoot ?? ""));

    // Auto-import the Vue composable so app code can call `useEveAgent()`
    // without an explicit import, matching Nuxt's composable conventions.
    addImports({ name: "useEveAgent", from: "eve/vue" });

    // Vite's dependency scan never sees an auto-import, so without this it
    // serves `eve/vue`'s CommonJS dependencies (such as `@vercel/oidc`) to the
    // browser unbundled in dev, and the app fails to hydrate.
    nuxt.options.vite.optimizeDeps = {
      ...nuxt.options.vite.optimizeDeps,
      include: [...(nuxt.options.vite.optimizeDeps?.include ?? []), "eve/vue"],
    };

    // On Vercel the eve agents deploy as sibling services. A Nitro runtime
    // `proxy` rule can't reach them — the proxied request loops back into the
    // Nuxt function and 404s — so declare the services and route eve transport
    // to them at the edge through the build output config.
    if (!nuxt.options.dev && process.env.VERCEL) {
      const nitro = (nuxt.options as typeof nuxt.options & { nitro: NitroVercelConfigHost }).nitro;
      const config = await addEveVercelServices(async () => nitro.vercel?.config ?? {}, {
        agents,
        eveBuildCommand: options.eveBuildCommand,
        host: EVE_NUXT_HOST,
        projectRoot: nuxtRoot,
      });
      if (config !== undefined) {
        nitro.vercel = { ...nitro.vercel, config };
      }
      return;
    }

    // Dev (and non-Vercel production, which proxies to an absolute origin):
    // booting the shared eve dev server can take a while, so defer it out of
    // module setup. `modules:done` still runs before Nitro is configured, so
    // the proxy route rule is registered in time while other modules' setup
    // isn't blocked behind the spawn.
    nuxt.hook("modules:done", async () => {
      const children: ChildProcess[] = [];
      await Promise.all(
        agents.map(async (agent) => {
          const publicPrefix = joinEveRoutePath(agent.publicRoutePrefix, EVE_ROUTE_PREFIX);
          let target: string;
          if (nuxt.options.dev) {
            // Each dev server serves the agent at `/eve/v1`, whichever name the
            // host mounts it under.
            const handle = await resolveEveAgentDevServer(agent, EVE_NUXT_HOST, devServerTimeoutMs);
            if (handle.process !== undefined) {
              children.push(handle.process);
            }
            target = `${handle.origin}${EVE_ROUTE_PREFIX}`;
          } else {
            // A built eve workspace serves each member under its own mount.
            target = `${resolveProductionOrigin()}${publicPrefix}`;
          }
          extendRouteRules(`${publicPrefix}/**`, { proxy: `${target}/**` });
        }),
      );
      if (children.length > 0) {
        // Prefer Nuxt's lifecycle for cleanup so the dev servers are torn down
        // on graceful shutdown and dev restarts. The process-exit guard in
        // framework-eve-server.ts remains as a fallback for non-graceful exits.
        nuxt.hook("close", () => {
          for (const child of children) {
            if (!child.killed) {
              child.kill();
            }
          }
        });
      }
    });
  },
}) as EveNuxtModule;

export default eveNuxtModule;
