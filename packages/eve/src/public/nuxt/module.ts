import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import {
  addImports,
  addServerPlugin,
  createResolver,
  defineNuxtModule,
  extendRouteRules,
} from "@nuxt/kit";
import type { NuxtModule } from "@nuxt/schema";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import {
  resolveDevServerTimeout,
  resolveSharedEveDevServer,
  type EveFrameworkHost,
} from "#shared/framework-eve-server.js";
import {
  ensureEveVercelServicesConfig,
  mergeEveVercelConfig,
  type VercelBuildConfig,
} from "#shared/vercel-services.js";

import { joinRoutePrefix, normalizeOrigin, resolveProductionTarget } from "./routing.js";

const EVE_BASE_URL_ENV = "EVE_BASE_URL";
const EVE_NUXT_HOST: EveFrameworkHost = { label: "Nuxt", slug: "nuxt" };

/**
 * Options for the eve Nuxt module.
 */
export interface EveNuxtModuleOptions {
  /**
   * Maximum time in milliseconds to wait for the eve development server to
   * start, including waiting for another Nuxt process to start it. Defaults
   * to 180000 (three minutes).
   */
  devServerTimeoutMs?: number;
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
 * Minimal view of the Nitro config the module writes to. The full `nitro`
 * typing lives behind the nitropack/Nuxt augmentation, which is not loaded in
 * this package's build, so model only the surface we touch.
 */
interface NitroConfigHost {
  externals?: {
    traceInclude?: string[];
    [key: string]: unknown;
  };
  vercel?: {
    config?: VercelBuildConfig;
    [key: string]: unknown;
  };
}

function readNitroConfig(nuxtOptions: object): NitroConfigHost {
  return (nuxtOptions as { nitro: NitroConfigHost }).nitro;
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
  readonly appRoot: string;
  readonly dev: boolean;
  readonly devServerTimeoutMs?: number;
  readonly onDevServerSpawned?: (child: ChildProcess) => void;
}): Promise<string> {
  if (!input.dev) {
    return resolveProductionTarget();
  }

  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl && configuredEveBaseUrl.length > 0) {
    return joinRoutePrefix(normalizeOrigin(configuredEveBaseUrl), EVE_ROUTE_PREFIX);
  }

  const handle = await resolveSharedEveDevServer({
    appRoot: input.appRoot,
    host: EVE_NUXT_HOST,
    timeoutMs: input.devServerTimeoutMs,
  });
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
 * service on Vercel deployments, and a loopback eve server the Nuxt server
 * process starts, or a configured origin, in non-Vercel production. Requires
 * Nuxt >= 4.0.0. Configure via
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
    const devServerTimeoutMs = resolveDevServerTimeout(options.devServerTimeoutMs, EVE_NUXT_HOST);

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
        appRoot,
        eveBuildCommand: options.eveBuildCommand,
        frameworkName: "Nuxt",
        hostRoot: nuxtRoot,
      });

      if (configured.mode === "generated") {
        const nitro = readNitroConfig(nuxt.options);
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
      if (!nuxt.options.dev) {
        // `node .output/server/index.mjs` never runs module setup, so the
        // built eve server has to start from a Nitro plugin at boot. The
        // plugin imports eve at runtime, so Nitro has to trace the package
        // into the server output.
        addServerPlugin(
          createResolver(import.meta.url).resolve("./runtime/production-server-plugin.js"),
        );
        const nitro = readNitroConfig(nuxt.options);
        nitro.externals = {
          ...nitro.externals,
          traceInclude: [...(nitro.externals?.traceInclude ?? []), "eve"],
        };
      }

      nuxt.hook("modules:done", async () => {
        const proxyTarget = await resolveEveProxyTarget({
          appRoot,
          dev: nuxt.options.dev,
          devServerTimeoutMs,
          onDevServerSpawned: (child) => {
            // Prefer Nuxt's lifecycle for cleanup so the dev server is torn
            // down on graceful shutdown and dev restarts. The process-exit
            // guard in framework-eve-server.ts remains as a fallback for non-graceful
            // exits.
            nuxt.hook("close", () => {
              if (!child.killed) {
                child.kill();
              }
            });
          },
        });

        extendRouteRules(`${EVE_ROUTE_PREFIX}/**`, {
          proxy: `${proxyTarget}/**`,
        });
      });
    }
  },
});

export default eveNuxtModule;
