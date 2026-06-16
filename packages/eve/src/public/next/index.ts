import { isAbsolute, resolve } from "node:path";

import type { NextConfig } from "next";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { resolveEveDestinationPrefix } from "./server.js";
import { ensureEveVercelOutputConfig } from "./vercel-output-config.js";

/**
 * Default private route namespace for hosting Eve as a separate experimental
 * Vercel service behind the Next.js app. {@link WithEveOptions.servicePrefix}
 * defaults to this value.
 */
export const EVE_NEXT_SERVICE_PREFIX = "/_eve_internal/eve";

const EVE_NEXT_PRODUCTION_ORIGIN_ENV = "EVE_NEXT_PRODUCTION_ORIGIN";
const EVE_NEXT_PRODUCTION_PORT_ENV = "EVE_NEXT_PRODUCTION_PORT";
const DEFAULT_EVE_BUILD_COMMAND = "eve build";
const DEFAULT_EVE_NEXT_PRODUCTION_PORT = 4274;
const EVE_PROXY_REWRITE_SOURCES: readonly string[] = [`${EVE_ROUTE_PREFIX}/:path+`];

type ArrayElement<T> = T extends readonly (infer TElement)[] ? TElement : never;
type NextRewrites = Awaited<ReturnType<NonNullable<NextConfig["rewrites"]>>>;

/**
 * Next.js rewrite rule that {@link withEve} emits.
 */
export type EveNextRewriteRule = ArrayElement<NextRewrites>;

/**
 * Resolved return type of a Next.js `rewrites` function: an array of rules, or
 * the sectioned `{ beforeFiles, afterFiles, fallback }` object.
 */
export type EveNextRewrites = NextRewrites;

/**
 * Sectioned Next.js rewrite rules.
 */
export type EveNextRewriteSections = Extract<
  NextRewrites,
  {
    readonly afterFiles?: EveNextRewriteRule[];
    readonly beforeFiles?: EveNextRewriteRule[];
    readonly fallback?: EveNextRewriteRule[];
  }
>;

/**
 * Alias of Next.js's `NextConfig`, the config object form {@link withEve}
 * accepts (the other being {@link EveNextConfigFunction}).
 */
export type EveNextConfig = NextConfig;

/**
 * Structural shape of a Next.js config function: receives the build `phase` and
 * a `context` containing `defaultConfig`, and returns a config (or a promise of
 * one). This is the form {@link withEve} returns.
 */
export type EveNextConfigFunction<TConfig extends EveNextConfig = EveNextConfig> = (
  phase: string,
  context: {
    readonly defaultConfig: TConfig;
  },
) => TConfig | Promise<TConfig>;

/**
 * Next.js config input that {@link withEve} accepts.
 */
export type EveNextConfigInput<TConfig extends EveNextConfig = EveNextConfig> =
  | EveNextConfigFunction<TConfig>
  | TConfig;

/**
 * Options for {@link withEve}.
 */
export interface WithEveOptions {
  /**
   * Maximum time in milliseconds to wait for the Eve development server to
   * start, including waiting for another Next.js process to start it. Defaults
   * to 180000 (three minutes).
   */
  readonly devServerTimeoutMs?: number;
  /**
   * Path to the Eve application root, relative to `process.cwd()` unless
   * absolute. Defaults to the Next.js app root.
   */
  readonly eveRoot?: string;
  /**
   * Build command for the generated Eve Vercel service. Defaults to `eve build`.
   * Use this when the Eve service needs project-specific prework before the
   * framework build, without changing the Next.js service build command.
   */
  readonly eveBuildCommand?: string;
  /**
   * Private Vercel service prefix for the Eve deployment. Defaults to
   * {@link EVE_NEXT_SERVICE_PREFIX} (`/_eve_internal/eve`). `withEve` normalizes
   * the prefix (adds a leading slash, strips trailing slashes) and rejects a
   * prefix that resolves to the root route. The prefix must match the Eve
   * service's mount in Vercel Build Output config.
   */
  readonly servicePrefix?: string;
}

function resolveApplicationRoot(appPath: string | undefined): string {
  if (appPath === undefined || appPath.length === 0) {
    return process.cwd();
  }

  return isAbsolute(appPath) ? appPath : resolve(process.cwd(), appPath);
}

function resolveDevServerTimeout(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Eve Next.js development server timeout must be a positive number.");
  }

  return timeoutMs;
}

function normalizeRoutePrefix(prefix: string): string {
  const prefixed = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const normalized = prefixed.replace(/\/+$/, "");

  if (normalized.length === 0) {
    throw new Error("Eve Next.js service prefix cannot resolve to the root route.");
  }

  return normalized;
}

function joinRoutePrefix(prefix: string, path: string): string {
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function normalizeOrigin(origin: string): string {
  return new URL(origin.trim()).origin;
}

function readLocalProductionPort(): number {
  const configuredPort = process.env[EVE_NEXT_PRODUCTION_PORT_ENV];

  if (configuredPort === undefined || configuredPort.trim().length === 0) {
    return DEFAULT_EVE_NEXT_PRODUCTION_PORT;
  }

  const port = Number.parseInt(configuredPort, 10);

  if (String(port) !== configuredPort.trim() || port < 1 || port > 65_535) {
    throw new Error(`${EVE_NEXT_PRODUCTION_PORT_ENV} must be an integer between 1 and 65535.`);
  }

  return port;
}

function resolveProductionDestination(servicePrefix: string): {
  readonly destinationPrefix: string;
  readonly localServerOrigin?: string;
} {
  if (process.env.VERCEL) {
    return {
      destinationPrefix: servicePrefix,
    };
  }

  const configuredOrigin = process.env[EVE_NEXT_PRODUCTION_ORIGIN_ENV];

  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return {
      destinationPrefix: joinRoutePrefix(normalizeOrigin(configuredOrigin), servicePrefix),
    };
  }

  const localServerOrigin = `http://127.0.0.1:${String(readLocalProductionPort())}`;
  return {
    destinationPrefix: localServerOrigin,
    localServerOrigin,
  };
}

function createEveRewriteRules(destinationPrefix: string): EveNextRewriteRule[] {
  return EVE_PROXY_REWRITE_SOURCES.map((source) => {
    const rule: EveNextRewriteRule = {
      destination: joinRoutePrefix(destinationPrefix, source),
      source,
    };

    return rule;
  });
}

async function resolveExistingRewrites(
  rewrites: EveNextConfig["rewrites"],
): Promise<EveNextRewrites | undefined> {
  return await rewrites?.();
}

function mergeRewriteRules(
  existing: EveNextRewrites | undefined,
  eveRules: EveNextRewriteRule[],
): EveNextRewrites {
  if (existing === undefined) {
    return {
      beforeFiles: eveRules,
    };
  }

  if (!isRewriteSections(existing)) {
    return {
      afterFiles: existing,
      beforeFiles: eveRules,
    };
  }

  return {
    ...existing,
    beforeFiles: [...eveRules, ...(existing.beforeFiles ?? [])],
  };
}

function isRewriteSections(rewrites: EveNextRewrites): rewrites is EveNextRewriteSections {
  return !Array.isArray(rewrites);
}

async function resolveNextConfig<TConfig extends EveNextConfig>(
  configOrFunction: EveNextConfigInput<TConfig>,
  phase: string,
  context: {
    readonly defaultConfig: TConfig;
  },
): Promise<TConfig> {
  return typeof configOrFunction === "function"
    ? await configOrFunction(phase, context)
    : configOrFunction;
}

/**
 * Wraps a Next.js config so same-origin Eve endpoints proxy to a separate Eve
 * service.
 *
 * In development, starts `eve dev --no-ui --port 0` for the Eve app and
 * rewrites Eve protocol endpoints to that local URL. In Vercel production,
 * rewrites to the resolved private Eve service prefix.
 * Outside Vercel production, serves an existing `.output/server/index.mjs` build
 * on a stable local port when present; otherwise set `EVE_NEXT_PRODUCTION_ORIGIN`
 * to the origin serving the Eve service namespace.
 */
export function withEve<TConfig extends EveNextConfig>(
  configOrFunction: EveNextConfigInput<TConfig>,
  options: WithEveOptions = {},
): EveNextConfigFunction<TConfig> {
  const nextRoot = process.cwd();
  const appRoot = resolveApplicationRoot(options.eveRoot);
  const devServerTimeoutMs = resolveDevServerTimeout(options.devServerTimeoutMs);
  const servicePrefixInput = normalizeRoutePrefix(options.servicePrefix ?? EVE_NEXT_SERVICE_PREFIX);

  return async function eveNextConfig(phase, context) {
    const nextConfig = await resolveNextConfig(configOrFunction, phase, context);
    const existingRewrites = nextConfig.rewrites;
    const configuredVercel = await ensureEveVercelOutputConfig({
      appRoot,
      eveBuildCommand: options.eveBuildCommand ?? DEFAULT_EVE_BUILD_COMMAND,
      nextRoot,
      servicePrefix: servicePrefixInput,
    });
    const productionDestination = resolveProductionDestination(configuredVercel.servicePrefix);

    return {
      ...nextConfig,
      async rewrites() {
        const [existing, destinationPrefix] = await Promise.all([
          resolveExistingRewrites(existingRewrites),
          resolveEveDestinationPrefix({
            appRoot,
            devServerTimeoutMs,
            phase,
            productionDestinationPrefix: productionDestination.destinationPrefix,
            productionServerOrigin: productionDestination.localServerOrigin,
          }),
        ]);

        return mergeRewriteRules(existing, createEveRewriteRules(destinationPrefix));
      },
    };
  };
}
