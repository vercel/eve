import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Plugin, PluginOption, ProxyOptions, UserConfig, ViteBuilder } from "vite";

import {
  parseVercelServicesConfig,
  type VercelServicesConfig,
} from "#internal/vercel/vercel-services-config.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath, normalizePublicEveRoutePath } from "#shared/eve-route-path.js";
import {
  addEveVercelServices,
  readEveBaseUrlOrigin,
  resolveEveAgentDevServer,
  resolveEveAgents,
  type EveFrameworkAgent,
} from "#shared/framework-eve-integration.js";
import { resolveDevServerTimeout, type EveFrameworkHost } from "#shared/framework-eve-server.js";
import { readOptionalFile } from "#shared/read-optional-file.js";

/**
 * Dev servers this process spawned, keyed by agent root. Module scope
 * survives Vite config restarts, which re-run `vite.config.ts` and reuse the
 * running servers through the shared registry.
 */
const spawnedDevServers = new Map<string, ChildProcess>();

/**
 * Options for eve's Vite plugins.
 */
export interface EveVitePluginOptions {
  /**
   * Maximum time in milliseconds to wait for each eve development server to
   * start, including waiting for another Vite process to start it. Defaults
   * to 180000 (three minutes).
   */
  readonly devServerTimeoutMs?: number;
  /**
   * Path to the eve project root, relative to the Vite root unless absolute.
   * The root may contain one `agent/` or an `agents/` workspace. Defaults to
   * the Vite root.
   */
  readonly eveRoot?: string;
  /**
   * Command that builds each eve agent inside its generated Vercel service.
   * Defaults to running the installed eve binary from the agent root
   * (`node <path-to>/eve/bin/eve.js build`).
   */
  readonly eveBuildCommand?: string;
}

/**
 * The slice of Nitro's `nitro` Vite config key the plugin writes. It is typed
 * locally so eve does not depend on Nitro's Vite type augmentation.
 */
type NitroUserConfig = UserConfig & {
  readonly nitro?: {
    readonly routeRules?: Record<string, { readonly proxy: string }>;
  };
};

/**
 * The slice of a Nitro module, and of the Nitro instance its `setup` receives,
 * that the plugin uses. Nitro's Vite plugin installs the `nitro` property of
 * any Vite plugin as a Nitro module.
 */
interface EveNitroModule {
  readonly name: string;
  setup(nitro: {
    readonly options: { vercel?: { config?: VercelServicesConfig; [key: string]: unknown } };
  }): Promise<void>;
}

function flattenPlugins(options: readonly PluginOption[]): Plugin[] {
  const plugins: Plugin[] = [];
  for (const option of options) {
    if (Array.isArray(option)) {
      plugins.push(...flattenPlugins(option));
    } else if (option !== null && typeof option === "object" && "name" in option) {
      plugins.push(option as Plugin);
    }
  }
  return plugins;
}

/**
 * Create a Vite plugin that runs eve agents alongside a Vite app.
 *
 * `nitroOnly` is for hosts that Nitro serves in every mode: the plugin then
 * requires the Nitro Vite plugin and leaves `vite preview` alone.
 * `vercelOutputAfterSsrBundle` is for hosts whose adapter writes
 * `.vercel/output` when the SSR build's bundle closes, after `buildApp`.
 */
export function createEveVitePlugin(input: {
  readonly host: EveFrameworkHost;
  readonly nitroOnly?: boolean;
  readonly options: EveVitePluginOptions;
  readonly vercelOutputAfterSsrBundle?: boolean;
}): Plugin & { readonly nitro: EveNitroModule } {
  const { host, nitroOnly, options, vercelOutputAfterSsrBundle } = input;
  const devServerTimeoutMs = resolveDevServerTimeout(options.devServerTimeoutMs, host);
  let viteRoot: string;
  let projectRoot: string;
  let agents: readonly EveFrameworkAgent[];
  let isPreview = false;
  let isSsrBuild = false;
  let isVercelBuild = false;
  let nitroModuleInstalled = false;
  // Nitro's own preview server answers every request, and its build Vite
  // instance does not share this module state, so its plugin name is the signal.
  let nitroServesPreview = false;

  async function addEveVercelServicesToOutput(): Promise<void> {
    const outputConfigPath = join(viteRoot, ".vercel", "output", "config.json");
    const config = await addEveVercelServices(
      async () => {
        const source = await readOptionalFile(outputConfigPath);
        if (source === undefined) {
          throw new Error(
            `The eve ${host.label} plugin found no Vercel Build Output at ${outputConfigPath} after the build. Use a framework or adapter that writes .vercel/output during vite build, or compose eve in vercel.ts with withEve from "eve/vercel".`,
          );
        }
        return parseVercelServicesConfig(JSON.parse(source), outputConfigPath);
      },
      {
        agents,
        eveBuildCommand: options.eveBuildCommand,
        host,
        hostRoot: viteRoot,
      },
    );
    if (config !== undefined) {
      await writeFile(outputConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    }
  }

  return {
    name: `eve:${host.slug}`,
    // Runs its build hooks after framework adapters have written `.vercel/output`.
    enforce: "post",
    nitro: {
      name: "eve",
      // Nitro writes `.vercel/output` from this config, so merging here puts
      // eve's routes ahead of the user's own `nitro({ vercel })` routes.
      async setup(nitro) {
        nitroModuleInstalled = true;
        if (!isVercelBuild) {
          return;
        }
        const config = await addEveVercelServices(async () => nitro.options.vercel?.config ?? {}, {
          agents,
          eveBuildCommand: options.eveBuildCommand,
          host,
          hostRoot: viteRoot,
        });
        if (config !== undefined) {
          nitro.options.vercel = { ...nitro.options.vercel, config };
        }
      },
    },
    config: {
      // Nitro reads its route rules from the config in its own `config` hook.
      order: "pre",
      async handler(config, env): Promise<NitroUserConfig> {
        viteRoot = resolve(config.root ?? "");
        projectRoot = resolve(viteRoot, options.eveRoot ?? "");
        isPreview = env.isPreview === true;
        nitroServesPreview =
          isPreview &&
          flattenPlugins(config.plugins ?? []).some((plugin) => plugin.name === "nitro:preview");
        isVercelBuild = env.command === "build" && Boolean(process.env.VERCEL);
        if (env.command !== "serve") {
          // Vercel needs the agents to generate their services; every other
          // build needs none, and may have no agent files at all.
          agents = isVercelBuild ? await resolveEveAgents(projectRoot) : [];
          return {};
        }
        // The proxy only needs the agent names, so a frontend that reaches an
        // agent elsewhere can build without local agent files.
        const configuredOrigin = readEveBaseUrlOrigin();
        agents =
          configuredOrigin === undefined
            ? await resolveEveAgents(projectRoot)
            : [{ appRoot: projectRoot, publicRoutePrefix: "" }];
        // Nitro answers every preview request itself, so a proxy or a dev
        // server here would do nothing. A Nitro-only host always reaches
        // preview through it.
        if (nitroServesPreview || (isPreview && nitroOnly)) {
          return {};
        }

        // Every workspace member's dev server serves it at `/eve/v1`, so
        // preview (which reuses dev servers) needs just one server.
        const origins = await Promise.all(
          (isPreview ? agents.slice(0, 1) : agents).map(async (agent) => {
            const handle = await resolveEveAgentDevServer(agent, host, devServerTimeoutMs);
            if (handle.process !== undefined) {
              spawnedDevServers.set(agent.appRoot, handle.process);
            }
            return handle.origin;
          }),
        );
        const proxy: Record<string, ProxyOptions> = {};
        const routeRules: Record<string, { readonly proxy: string }> = {};
        for (const [index, agent] of agents.entries()) {
          const origin = origins[isPreview ? 0 : index];
          const publicPrefix = joinEveRoutePath(agent.publicRoutePrefix, EVE_ROUTE_PREFIX);
          proxy[publicPrefix] = {
            changeOrigin: true,
            rewrite: normalizePublicEveRoutePath,
            target: origin,
          };
          routeRules[`${publicPrefix}/**`] = {
            proxy: `${origin}${EVE_ROUTE_PREFIX}/**`,
          };
        }

        if (isPreview) {
          return { preview: { proxy } };
        }
        // Nitro answers dev requests before Vite's proxy middleware runs, so
        // Nitro-served apps need the proxies as route rules too.
        return { nitro: { routeRules }, server: { proxy } };
      },
    },
    configResolved(config) {
      isSsrBuild = Boolean(config.build.ssr);
      // Nitro installs the `nitro` module above while resolving config.
      // Without Nitro the eve routes would silently 404.
      if (nitroOnly && !isPreview && !nitroModuleInstalled) {
        throw new Error(
          `The eve ${host.label} plugin needs the Nitro Vite plugin. Install "nitro" and add nitro() from "nitro/vite" to the plugins in vite.config.ts.`,
        );
      }
    },
    closeServer({ reason }) {
      if (reason === "close") {
        for (const agent of agents) {
          spawnedDevServers.get(agent.appRoot)?.kill();
          spawnedDevServers.delete(agent.appRoot);
        }
      }
    },
    buildApp: {
      order: "post",
      async handler(builder: ViteBuilder) {
        if (!isVercelBuild || nitroModuleInstalled || vercelOutputAfterSsrBundle) {
          return;
        }
        // `buildApp` runs before Vite builds the environments that `--app`
        // selects, so the adapter has not written `.vercel/output` yet.
        for (const environment of Object.values(builder.environments)) {
          if (!environment.isBuilt) {
            await builder.build(environment);
          }
        }
        await addEveVercelServicesToOutput();
      },
    },
    closeBundle: {
      sequential: true,
      async handler() {
        if (isVercelBuild && isSsrBuild && vercelOutputAfterSsrBundle) {
          await addEveVercelServicesToOutput();
        }
      },
    },
  };
}
