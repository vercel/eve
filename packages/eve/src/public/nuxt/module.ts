import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";

import { addImports, defineNuxtModule, extendRouteRules } from "@nuxt/kit";

import type { VercelServicesConfig } from "#internal/vercel/vercel-services-config.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { joinEveRoutePath } from "#shared/eve-route-path.js";
import { loadPlatformBuild } from "#platform/selection.js";
import { usesPlatformOutput } from "#platform/entities.js";
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
    const eveProjectRoot = resolve(nuxtRoot, options.eveRoot ?? "");

    addImports({ name: "useEveAgent", from: "eve/vue" });

    nuxt.options.vite.optimizeDeps = {
      ...nuxt.options.vite.optimizeDeps,
      include: [...(nuxt.options.vite.optimizeDeps?.include ?? []), "eve/vue"],
    };

    if (!nuxt.options.dev && usesPlatformOutput(await loadPlatformBuild(eveProjectRoot))) {
      const nitro = (nuxt.options as typeof nuxt.options & { nitro: NitroVercelConfigHost }).nitro;
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

    nuxt.hook("modules:done", async () => {
      const agents =
        readEveBaseUrlOrigin() === undefined
          ? await resolveEveAgents(eveProjectRoot)
          : [{ appRoot: eveProjectRoot, publicRoutePrefix: "" }];
      const children: ChildProcess[] = [];
      await Promise.all(
        agents.map(async (agent, index) => {
          const publicPrefix = joinEveRoutePath(agent.publicRoutePrefix, EVE_ROUTE_PREFIX);
          let target: string;
          if (nuxt.options.dev) {
            const handle = await resolveEveAgentDevServer(agent, EVE_NUXT_HOST, devServerTimeoutMs);
            if (handle.process !== undefined) {
              children.push(handle.process);
            }
            target = `${handle.origin}${EVE_ROUTE_PREFIX}`;
          } else {
            target = resolveProductionTarget({ portOffset: index, publicPrefix });
          }
          extendRouteRules(`${publicPrefix}/**`, { proxy: `${target}/**` });
        }),
      );
      if (children.length > 0) {
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
