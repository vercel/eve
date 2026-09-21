import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { addImports, defineNuxtModule, extendRouteRules } from "@nuxt/kit";
import type { NuxtModule } from "@nuxt/schema";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import {
  assertFrameworkAgentsPresent,
  resolveFrameworkAgents,
  type ResolvedFrameworkAgent,
} from "#shared/framework-agents.js";
import {
  ensureEveVercelServicesConfig,
  mergeEveVercelConfig,
  type VercelBuildConfig,
} from "#shared/vercel-services.js";

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";
import { joinRoutePrefix, normalizeOrigin, resolveProductionTarget } from "./routing.js";

/**
 * Options for the eve Nuxt module.
 */
export interface EveNuxtModuleOptions {
  /**
   * Path to the eve application root, resolved relative to the Nuxt project
   * root unless absolute. Defaults to the Nuxt project root. The dev server is
   * spawned here, and on Vercel it is the root the generated eve service
   * builds from.
   */
  eveRoot?: string;
  /**
   * Command that builds the eve app inside the generated Vercel eve service.
   * Defaults to running the installed eve binary from the Nuxt app's
   * dependencies (`node <path-to>/eve/bin/eve.js build`).
   */
  eveBuildCommand?: string;
}

function resolveApplicationRoot(nuxtRoot: string, appPath: string | undefined): string {
  if (appPath === undefined || appPath.length === 0) {
    return nuxtRoot;
  }
  return isAbsolute(appPath) ? appPath : resolve(nuxtRoot, appPath);
}

/**
 * Minimal view of the Nitro Vercel build-output config the module merges the
 * eve service into. The full `nitro` typing lives behind the nitropack/Nuxt
 * augmentation, which is not loaded in this package's build, so model only the
 * surface we touch.
 */
interface NitroVercelConfigHost {
  vercel?: {
    config?: VercelBuildConfig;
    [key: string]: unknown;
  };
}

/**
 * Resolve the destination eve routes proxy to. In dev this is an explicit
 * `EVE_BASE_URL` or a shared dev server spawned on demand; in non-Vercel
 * production it is a configured origin/port.
 *
 * When a dev server is spawned by this process, `onDevServerSpawned` is invoked
 * with the child handle so the caller can wire lifecycle-scoped cleanup.
 */
async function resolveEveProxyTarget(input: {
  readonly agent: ResolvedFrameworkAgent;
  readonly dev: boolean;
  readonly localProductionPortOffset: number;
  readonly onDevServerSpawned?: (child: ChildProcess) => void;
}): Promise<string> {
  if (!input.dev) {
    return resolveProductionTarget({
      localPortOffset: input.localProductionPortOffset,
      routePrefix: input.agent.transportRoutePrefix,
    });
  }

  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl && configuredEveBaseUrl.length > 0) {
    return joinRoutePrefix(normalizeOrigin(configuredEveBaseUrl), input.agent.transportRoutePrefix);
  }

  const handle = await resolveSharedEveDevServer(input.agent.appRoot);
  if (handle.process !== undefined) {
    input.onDevServerSpawned?.(handle.process);
  }

  return joinRoutePrefix(handle.origin, EVE_ROUTE_PREFIX);
}

/**
 * Nuxt module that wires an eve agent into a Nuxt app. Register under `modules`
 * (configured via the `eve` config key). It auto-imports the `useEveAgent()`
 * composable and routes eve transport requests (`/eve/v1/**`) to the eve
 * service: a shared dev server spawned on demand in dev, a generated Vercel
 * service on Vercel deployments, and a configured origin/port in non-Vercel
 * production. Requires Nuxt >= 4.0.0. Configure via
 * {@link EveNuxtModuleOptions}.
 */
const eveNuxtModule: NuxtModule<EveNuxtModuleOptions> = defineNuxtModule<EveNuxtModuleOptions>({
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
    const appRoot = resolveApplicationRoot(nuxtRoot, options.eveRoot);
    const agents = await resolveFrameworkAgents(appRoot);
    assertFrameworkAgentsPresent(agents, appRoot);

    // Auto-import the Vue composable so app code can call `useEveAgent()`
    // without an explicit import, matching Nuxt's composable conventions.
    addImports({ name: "useEveAgent", from: "eve/vue" });

    // On Vercel the eve app deploys as a sibling service. A Nitro runtime
    // `proxy` rule can't reach it — the proxied request loops back into the
    // Nuxt function and 404s — so declare the service and route eve transport
    // to it at the edge through the build output config, mirroring the Next.js
    // integration.
    if (!nuxt.options.dev && process.env.VERCEL) {
      const configured = await ensureEveVercelServicesConfig({
        agents,
        appRoot,
        eveBuildCommand: options.eveBuildCommand,
        frameworkName: "Nuxt",
        hostRoot: nuxtRoot,
      });

      if (configured.mode === "generated") {
        const nitro = (nuxt.options as typeof nuxt.options & { nitro: NitroVercelConfigHost })
          .nitro;
        nitro.vercel = {
          ...nitro.vercel,
          config: mergeEveVercelConfig(nitro.vercel?.config, configured),
        };
      }
    } else {
      // Dev (and non-Vercel production, which proxies to an absolute origin):
      // booting the shared eve dev server can take a while, so defer it out of
      // module setup. `modules:done` still runs before Nitro is configured, so
      // the proxy route rule is registered in time while other modules' setup
      // isn't blocked behind the spawn.
      nuxt.hook("modules:done", async () => {
        await Promise.all(
          agents.map(async (agent, index) => {
            const proxyTarget = await resolveEveProxyTarget({
              agent,
              dev: nuxt.options.dev,
              localProductionPortOffset: index,
              onDevServerSpawned: (child) => {
                // Prefer Nuxt's lifecycle for cleanup so the dev server is torn
                // down on graceful shutdown and dev restarts. The process-exit
                // guard in dev-server.ts remains as a fallback for non-graceful
                // exits.
                nuxt.hook("close", () => {
                  if (!child.killed) child.kill();
                });
              },
            });

            extendRouteRules(`${agent.transportRoutePrefix}/**`, {
              proxy: `${proxyTarget}/**`,
            });
          }),
        );
      });
    }
  },
});

export default eveNuxtModule;
