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

type NitroUserConfig = UserConfig & {
  readonly nitro?: {
    readonly routeRules?: Record<string, { readonly proxy: string }>;
  };
};

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
    enforce: "post",
    nitro: {
      name: "eve",
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
          agents = isVercelBuild ? await resolveEveAgents(projectRoot) : [];
          return {};
        }
        const configuredOrigin = readEveBaseUrlOrigin();
        agents =
          configuredOrigin === undefined
            ? await resolveEveAgents(projectRoot)
            : [{ appRoot: projectRoot, publicRoutePrefix: "" }];
        if (nitroServesPreview || (isPreview && nitroOnly)) {
          return {};
        }

        const origins = await Promise.all(
          agents.map(async (agent) => {
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
          const origin = origins[index];
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
        return { nitro: { routeRules }, server: { proxy } };
      },
    },
    configResolved(config) {
      isSsrBuild = Boolean(config.build.ssr);
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
