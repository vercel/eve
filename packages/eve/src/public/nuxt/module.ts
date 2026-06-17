import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { addImports, defineNuxtModule, extendRouteRules } from "@nuxt/kit";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";
import {
  EVE_NUXT_SERVICE_PREFIX,
  createEveVercelRewriteRoute,
  joinRoutePrefix,
  normalizeOrigin,
  normalizeRoutePrefix,
  resolveProductionTarget,
} from "./routing.js";
import { ensureEveVercelJson } from "./vercel-json.js";

export { EVE_NUXT_SERVICE_PREFIX };

const DEFAULT_EVE_BUILD_COMMAND = "eve build";

/**
 * Options for the eve Nuxt module.
 */
export interface EveNuxtModuleOptions {
  /**
   * Path to the eve application root, resolved relative to the Nuxt project
   * root unless absolute. Defaults to the Nuxt project root. The dev server is
   * spawned here and written as the eve service entrypoint in `vercel.json`
   * (relative to the Nuxt root).
   */
  eveRoot?: string;
  /**
   * Build command for the generated eve Vercel service. Defaults to `"eve build"`.
   */
  eveBuildCommand?: string;
  /**
   * Set to `false` to skip creating or updating `vercel.json`. By default the
   * module ensures `vercel.json` contains `experimentalServices` for the Nuxt
   * app and eve app.
   */
  configureVercelJson?: boolean;
  /**
   * Private Vercel service prefix eve transport is proxied to. Defaults to
   * {@link EVE_NUXT_SERVICE_PREFIX}. When `configureVercelJson` is enabled, it
   * is written as the eve service `routePrefix`, but an existing `routePrefix`
   * in `vercel.json` takes precedence. Normalized to a leading-slash,
   * no-trailing-slash route; cannot resolve to `/`.
   */
  servicePrefix?: string;
}

function resolveApplicationRoot(nuxtRoot: string, appPath: string | undefined): string {
  if (appPath === undefined || appPath.length === 0) {
    return nuxtRoot;
  }
  return isAbsolute(appPath) ? appPath : resolve(nuxtRoot, appPath);
}

/**
 * Minimal view of the Nitro Vercel build-output config the module appends to.
 * The full `nitro` typing lives behind the nitropack/Nuxt augmentation, which
 * is not loaded in this package's build, so model only the surface we touch.
 */
interface NitroVercelConfigHost {
  vercel?: {
    config?: {
      version?: number;
      routes?: unknown[];
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
}

/**
 * Resolve the destination eve routes proxy to. In dev this is an explicit
 * `EVE_BASE_URL` or a shared dev server spawned on demand; in production it is
 * the Vercel private service or a configured origin/port.
 *
 * When a dev server is spawned by this process, `onDevServerSpawned` is invoked
 * with the child handle so the caller can wire lifecycle-scoped cleanup.
 */
async function resolveEveProxyTarget(input: {
  readonly appRoot: string;
  readonly dev: boolean;
  readonly servicePrefix: string;
  readonly onDevServerSpawned?: (child: ChildProcess) => void;
}): Promise<string> {
  if (!input.dev) {
    return resolveProductionTarget(input.servicePrefix);
  }

  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl && configuredEveBaseUrl.length > 0) {
    return joinRoutePrefix(normalizeOrigin(configuredEveBaseUrl), EVE_ROUTE_PREFIX);
  }

  const handle = await resolveSharedEveDevServer(input.appRoot);
  if (handle.process !== undefined) {
    input.onDevServerSpawned?.(handle.process);
  }

  return joinRoutePrefix(handle.origin, EVE_ROUTE_PREFIX);
}

/**
 * Nuxt module that wires an eve agent into a Nuxt app. Register under `modules`
 * (configured via the `eve` config key). It auto-imports the `useEveAgent()`
 * composable, routes eve transport requests (`/eve/v1/**`) to the eve service
 * (a shared dev server spawned on demand in dev, a Vercel sibling service or a
 * configured origin/port in production), and unless `configureVercelJson` is
 * `false`, ensures `vercel.json` declares both the Nuxt and eve services.
 * Requires Nuxt >= 4.0.0. Configure via {@link EveNuxtModuleOptions}.
 */
export default defineNuxtModule<EveNuxtModuleOptions>({
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
    const servicePrefix = normalizeRoutePrefix(options.servicePrefix ?? EVE_NUXT_SERVICE_PREFIX);
    const shouldConfigureVercelJson = options.configureVercelJson !== false;

    // Auto-import the Vue composable so app code can call `useEveAgent()`
    // without an explicit import, matching Nuxt's composable conventions.
    addImports({ name: "useEveAgent", from: "eve/vue" });

    // On Vercel the eve app deploys as a sibling experimental service. A Nitro
    // runtime `proxy` rule can't reach it — the proxied request loops back into
    // the Nuxt function and 404s — so route eve transport at the edge via a
    // build-config rewrite, mirroring the Next.js integration.
    if (!nuxt.options.dev && process.env.VERCEL) {
      const rewrite = createEveVercelRewriteRoute(servicePrefix);
      const nitro = (nuxt.options as typeof nuxt.options & { nitro: NitroVercelConfigHost }).nitro;
      const existing = nitro.vercel?.config;
      nitro.vercel = {
        ...nitro.vercel,
        config: {
          version: 3,
          ...existing,
          routes: [rewrite, ...(existing?.routes ?? [])],
        },
      };
    } else {
      // Dev (and non-Vercel production, which proxies to an absolute origin):
      // booting the shared eve dev server can take a while, so defer it out of
      // module setup. `modules:done` still runs before Nitro is configured, so
      // the proxy route rule is registered in time while other modules' setup
      // isn't blocked behind the spawn.
      nuxt.hook("modules:done", async () => {
        const proxyTarget = await resolveEveProxyTarget({
          appRoot,
          dev: nuxt.options.dev,
          servicePrefix,
          onDevServerSpawned: (child) => {
            // Prefer Nuxt's lifecycle for cleanup so the dev server is torn
            // down on graceful shutdown and dev restarts. The process-exit
            // guard in dev-server.ts remains as a fallback for non-graceful
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

    if (shouldConfigureVercelJson) {
      await ensureEveVercelJson({
        appRoot,
        eveBuildCommand: options.eveBuildCommand ?? DEFAULT_EVE_BUILD_COMMAND,
        nuxtRoot,
        servicePrefix,
      });
    }
  },
});
