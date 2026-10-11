import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import type { Plugin, UserConfig } from "vite";

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

const EVE_BASE_URL_ENV = "EVE_BASE_URL";
const EVE_TANSTACK_HOST: EveFrameworkHost = { label: "TanStack Start", slug: "tanstack" };

/**
 * Dev servers this process spawned, keyed by eve app root. Module scope
 * survives Vite config restarts, which re-run `vite.config.ts` and reuse the
 * running server through the shared registry.
 */
const spawnedDevServers = new Map<string, ChildProcess>();

/**
 * Options for the eve TanStack Start Vite plugin.
 */
export interface EveTanStackPluginOptions {
  /**
   * Maximum time in milliseconds to wait for the eve development server to
   * start, including waiting for another TanStack Start process to start it.
   * Defaults to 180000 (three minutes).
   */
  readonly devServerTimeoutMs?: number;
  /**
   * Path to the eve application root, relative to the TanStack Start project
   * root unless absolute. Defaults to the TanStack Start project root.
   */
  readonly eveRoot?: string;
  /**
   * Command that builds the eve app inside the generated Vercel eve service.
   * Defaults to running the installed eve binary from the TanStack Start
   * app's dependencies (`node <path-to>/eve/bin/eve.js build`).
   */
  readonly eveBuildCommand?: string;
}

/**
 * The slice of Nitro's `nitro` Vite config key this plugin writes. It is typed
 * locally so eve does not depend on Nitro's Vite type augmentation.
 */
type NitroUserConfig = UserConfig & {
  readonly nitro?: {
    readonly routeRules?: Record<string, { readonly proxy: string }>;
  };
};

/**
 * The slice of a Nitro module, and of the Nitro instance its `setup` receives,
 * that this plugin uses. Nitro's Vite plugin installs the `nitro` property of
 * any Vite plugin as a Nitro module.
 */
interface EveNitroModule {
  readonly name: string;
  setup(nitro: {
    readonly options: { vercel?: { config?: VercelBuildConfig; [key: string]: unknown } };
  }): Promise<void>;
}

function resolveApplicationRoot(hostRoot: string, appPath: string | undefined): string {
  if (appPath === undefined || appPath.length === 0) {
    return hostRoot;
  }
  return isAbsolute(appPath) ? appPath : resolve(hostRoot, appPath);
}

function parseEveBaseUrl(value: string): string {
  const url = URL.parse(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(
      `${EVE_BASE_URL_ENV} must be an absolute http(s) URL such as http://127.0.0.1:2000, received "${value}".`,
    );
  }
  return url.origin;
}

async function resolveEveDevOrigin(
  appRoot: string,
  timeoutMs: number | undefined,
): Promise<string> {
  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl && configuredEveBaseUrl.length > 0) {
    return parseEveBaseUrl(configuredEveBaseUrl);
  }

  const handle = await resolveSharedEveDevServer({ appRoot, host: EVE_TANSTACK_HOST, timeoutMs });
  if (handle.process !== undefined) {
    spawnedDevServers.set(appRoot, handle.process);
  }
  return handle.origin;
}

function stopSpawnedDevServer(appRoot: string): void {
  const child = spawnedDevServers.get(appRoot);
  spawnedDevServers.delete(appRoot);
  if (child !== undefined && !child.killed) {
    child.kill();
  }
}

/**
 * Vite plugin for running an eve agent alongside a TanStack Start app.
 *
 * TanStack Start reaches Vercel through Nitro, so the app must register
 * `nitro()` from `nitro/vite`; `eveTanStack` configures Nitro to route eve.
 *
 * In development, Nitro proxies eve protocol endpoints to a local eve server.
 * It resolves the server in order: the `EVE_BASE_URL` env var if set, then a
 * healthy shared eve dev server already running for the app, then a freshly
 * spawned `eve dev --no-ui --port 0`. A server spawned by the plugin stops
 * when the Vite dev server closes.
 *
 * On Vercel builds, `eveTanStack` adds the eve runtime as a sibling Vercel
 * service and routes its transport requests before TanStack Start's own
 * routing, including routes declared in `nitro({ vercel: { config } })`.
 */
export function eveTanStack(options: EveTanStackPluginOptions = {}): Plugin {
  const devServerTimeoutMs = resolveDevServerTimeout(options.devServerTimeoutMs, EVE_TANSTACK_HOST);
  let hostRoot = process.cwd();
  let appRoot = resolveApplicationRoot(hostRoot, options.eveRoot);
  let isPreview = false;
  let isVercelBuild = false;
  let nitroModuleInstalled = false;

  const plugin: Plugin & { readonly nitro: EveNitroModule } = {
    name: "eve:tanstack",
    enforce: "pre",
    nitro: {
      name: "eve",
      // Merging here rather than through the `nitro` Vite config key lets eve
      // see the user's own `nitro({ vercel })` config: that key has the
      // lowest priority, so user routes would otherwise land ahead of eve's.
      async setup(nitro) {
        nitroModuleInstalled = true;
        if (!isVercelBuild) {
          return;
        }

        const configured = await ensureEveVercelServicesConfig({
          appRoot,
          eveBuildCommand: options.eveBuildCommand,
          frameworkName: "TanStack Start",
          hostRoot,
        });
        if (configured.mode !== "generated") {
          return;
        }

        nitro.options.vercel = {
          ...nitro.options.vercel,
          config: mergeEveVercelConfig(nitro.options.vercel?.config, configured),
        };
      },
    },
    async config(config, env): Promise<NitroUserConfig> {
      isPreview = env.isPreview === true;
      if (isPreview) {
        return {};
      }

      hostRoot = resolve(process.cwd(), config.root ?? ".");
      appRoot = resolveApplicationRoot(hostRoot, options.eveRoot);
      isVercelBuild = env.command === "build" && Boolean(process.env.VERCEL);

      if (env.command !== "serve") {
        return {};
      }

      const origin = await resolveEveDevOrigin(appRoot, devServerTimeoutMs);
      // Vite's own `server.proxy` never runs: Nitro answers dev requests
      // before Vite's proxy middleware. The rule stays on the config key
      // because Nitro has normalized route rules by the time modules run.
      return {
        nitro: {
          routeRules: {
            [`${EVE_ROUTE_PREFIX}/**`]: { proxy: `${origin}${EVE_ROUTE_PREFIX}/**` },
          },
        },
      };
    },
    configResolved() {
      // Nitro installs the `nitro` module above while resolving config.
      // Without Nitro the eve routes would silently 404.
      if (!isPreview && !nitroModuleInstalled) {
        throw new Error(
          'eveTanStack() needs the Nitro Vite plugin. Install "nitro" and add nitro() from "nitro/vite" to the plugins in vite.config.ts.',
        );
      }
    },
    closeServer({ reason }) {
      if (reason === "close") {
        stopSpawnedDevServer(appRoot);
      }
    },
  };
  return plugin;
}
