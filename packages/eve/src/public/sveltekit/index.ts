import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { Plugin, ResolvedConfig, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import {
  ensureEveVercelServicesConfig,
  mergeEveVercelConfig,
  type EnsureEveVercelServicesConfigResult,
  type VercelBuildConfig,
} from "#shared/vercel-services.js";

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";
import { normalizeOrigin } from "./routing.js";

/**
 * Options for the eve SvelteKit Vite plugin.
 */
export interface EveSvelteKitPluginOptions {
  /**
   * Path to the eve application root, relative to the SvelteKit project root
   * unless absolute. Defaults to the SvelteKit project root.
   */
  readonly eveRoot?: string;
  /**
   * Command that builds the eve app inside the generated Vercel eve service.
   * Defaults to running the installed eve binary from the SvelteKit app's
   * dependencies (`node <path-to>/eve/bin/eve.js build`).
   */
  readonly eveBuildCommand?: string;
}

function resolveApplicationRoot(svelteKitRoot: string, appPath: string | undefined): string {
  if (appPath === undefined || appPath.length === 0) {
    return svelteKitRoot;
  }
  return isAbsolute(appPath) ? appPath : resolve(svelteKitRoot, appPath);
}

function mergeProxyConfig(
  existingProxy: NonNullable<UserConfig["server"]>["proxy"],
  eveTarget: string,
): NonNullable<UserConfig["server"]>["proxy"] {
  return {
    ...existingProxy,
    [EVE_ROUTE_PREFIX]: {
      changeOrigin: true,
      target: eveTarget,
    },
  };
}

async function resolveEveDevProxyTarget(appRoot: string): Promise<string> {
  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl && configuredEveBaseUrl.length > 0) {
    return normalizeOrigin(configuredEveBaseUrl);
  }

  return (await resolveSharedEveDevServer(appRoot)).origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function mergeGeneratedVercelServicesConfig(input: {
  readonly generated: Extract<EnsureEveVercelServicesConfigResult, { mode: "generated" }>;
  readonly outputConfigPath: string;
}): Promise<void> {
  let outputConfigContents: string;

  try {
    outputConfigContents = await readFile(input.outputConfigPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  const outputConfig: unknown = JSON.parse(outputConfigContents);

  if (!isRecord(outputConfig)) {
    throw new Error("Vercel Build Output config.json must contain a JSON object.");
  }

  const merged = mergeEveVercelConfig(outputConfig as VercelBuildConfig, input.generated);
  await writeFile(input.outputConfigPath, `${JSON.stringify(merged, null, 2)}\n`);
}

/**
 * Vite plugin for running an eve agent alongside a SvelteKit app.
 *
 * In development and local preview, `eveSvelteKit` proxies eve protocol
 * endpoints to a local eve server. It resolves the server in order: the
 * `EVE_BASE_URL` env var if set, then a healthy shared eve dev server already
 * running for the app, then a freshly spawned `eve dev --no-ui --port 0`.
 *
 * On Vercel builds, `eveSvelteKit` adds the eve runtime as a sibling Vercel
 * service and routes its transport requests before SvelteKit filesystem
 * routing.
 */
export function eveSvelteKit(options: EveSvelteKitPluginOptions = {}): Plugin {
  let svelteKitRoot = process.cwd();
  let appRoot = resolveApplicationRoot(svelteKitRoot, options.eveRoot);
  let isSsrBuild = false;
  let generatedVercelServices:
    | Extract<EnsureEveVercelServicesConfigResult, { mode: "generated" }>
    | undefined;

  return {
    enforce: "post",
    name: "eve:sveltekit",
    async config(config, env) {
      svelteKitRoot =
        config.root === undefined ? process.cwd() : resolve(process.cwd(), config.root);
      appRoot = resolveApplicationRoot(svelteKitRoot, options.eveRoot);

      if (env.command === "build" && process.env.VERCEL) {
        const configured = await ensureEveVercelServicesConfig({
          appRoot,
          eveBuildCommand: options.eveBuildCommand,
          frameworkName: "SvelteKit",
          hostRoot: svelteKitRoot,
        });

        generatedVercelServices = configured.mode === "generated" ? configured : undefined;
      }

      if (env.command !== "serve") {
        return {};
      }

      const proxyTarget = await resolveEveDevProxyTarget(appRoot);

      if (env.isPreview) {
        return {
          preview: {
            proxy: mergeProxyConfig(config.preview?.proxy, proxyTarget),
          },
        };
      }

      return {
        server: {
          proxy: mergeProxyConfig(config.server?.proxy, proxyTarget),
        },
      };
    },
    configResolved(config: ResolvedConfig) {
      isSsrBuild = Boolean(config.build.ssr);
      svelteKitRoot = config.root;
    },
    closeBundle: {
      sequential: true,
      async handler() {
        if (!isSsrBuild || generatedVercelServices === undefined) {
          return;
        }

        await mergeGeneratedVercelServicesConfig({
          generated: generatedVercelServices,
          outputConfigPath: join(svelteKitRoot, ".vercel", "output", "config.json"),
        });
      },
    },
  };
}
