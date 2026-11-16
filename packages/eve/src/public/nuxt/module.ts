import type { ChildProcess } from "node:child_process";
import { relative, resolve } from "node:path";

import {
  addImports,
  addServerPlugin,
  addTemplate,
  defineNuxtModule,
  extendRouteRules,
} from "@nuxt/kit";

import type { VercelServicesConfig } from "#internal/vercel/vercel-services-config.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import {
  addEveVercelServices,
  readEveBaseUrlOrigin,
  resolveEveAgentDevServer,
  resolveEveAgents,
} from "#shared/framework-eve-integration.js";
import { resolveDevServerTimeout, type EveFrameworkHost } from "#shared/framework-eve-server.js";

import { resolveProductionTarget } from "./production-origin.js";

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
   * one `agent/` or an `agents/` workspace. Managed non-Vercel production
   * serves each agent's existing build; keep eve and Nuxt outputs separate.
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
interface NitroConfigHost {
  preset?: string;
  externals?: { inline?: string[]; [key: string]: unknown };
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
 * deployments, and managed eve servers or a configured origin in non-Vercel production. Requires
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
    const eveProjectRoot = resolve(nuxtRoot, options.eveRoot ?? "");

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
      const nitro = (nuxt.options as typeof nuxt.options & { nitro: NitroConfigHost }).nitro;
      const config = await addEveVercelServices(async () => nitro.vercel?.config ?? {}, {
        agents: await resolveEveAgents(eveProjectRoot),
        eveBuildCommand: options.eveBuildCommand,
        host: EVE_NUXT_HOST,
        hostRoot: nuxtRoot,
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
      // The proxy only needs the agent names, so a frontend that reaches an
      // agent elsewhere needs no local agent files.
      const agents =
        nuxt.options.dev && readEveBaseUrlOrigin() !== undefined
          ? [{ appRoot: eveProjectRoot, publicRoutePrefix: "" }]
          : await resolveEveAgents(eveProjectRoot);
      const children: ChildProcess[] = [];
      const productionServers: {
        origin: string;
        relativeRoot: string;
        agentRoot: string;
        publicPrefix: string;
      }[] = [];
      const managed =
        !nuxt.options.dev &&
        !(nuxt.options as { _generate?: boolean })._generate &&
        !process.env.EVE_NUXT_PRODUCTION_ORIGIN?.trim();
      if (managed) {
        const nitro = (nuxt.options as typeof nuxt.options & { nitro: NitroConfigHost }).nitro;
        const preset = (
          nitro.preset ||
          process.env.NITRO_PRESET ||
          process.env.SERVER_PRESET ||
          "node-server"
        )
          .replace(/([a-z])([A-Z])/g, "$1-$2")
          .toLowerCase();
        if (preset !== "node-server") {
          throw new Error(
            `eve managed Nuxt startup requires the single-process node-server preset, not ${preset}. Set EVE_NUXT_PRODUCTION_ORIGIN to an externally managed eve service when building Nuxt.`,
          );
        }
      }
      await Promise.all(
        agents.map(async (agent, index) => {
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
            // An origin override mounts every agent under its public prefix;
            // otherwise each member runs as its own server on the next port.
            target = resolveProductionTarget({ portOffset: index, publicPrefix });
            if (managed) {
              productionServers.push({
                origin: new URL(target).origin,
                relativeRoot: relative(nuxtRoot, eveProjectRoot),
                agentRoot: relative(eveProjectRoot, agent.appRoot),
                publicPrefix,
              });
            }
          }
          extendRouteRules(`${publicPrefix}/**`, { proxy: `${target}/**` });
        }),
      );
      if (managed) {
        const plugin = addTemplate({
          filename: "eve-production-server.mjs",
          write: true,
          getContents:
            () => `import createEveProductionServerPlugin from "eve/nuxt/production-server";
export default import.meta.prerender ? () => {} : createEveProductionServerPlugin(${JSON.stringify(productionServers)});
`,
        });
        addServerPlugin(plugin.dst);
        // Nitro's tracer cannot follow workspace symlinks or preserve eve's private aliases.
        const nitro = (nuxt.options as typeof nuxt.options & { nitro: NitroConfigHost }).nitro;
        nitro.externals = {
          ...nitro.externals,
          inline: [...(nitro.externals?.inline ?? []), "eve/nuxt/production-server"],
        };
      }
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
