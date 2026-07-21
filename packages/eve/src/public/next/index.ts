import { isAbsolute, relative, resolve } from "node:path";

import type { NextConfig } from "next";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { resolveEveBinaryPath } from "./resolve-eve-binary.js";
import { resolveEveDestinationPrefix } from "./server.js";
import { ensureEveVercelOutputConfig } from "./vercel-output-config.js";

/**
 * Default private route namespace for legacy manually configured Vercel
 * services. {@link WithEveOptions.servicePrefix} defaults to this value.
 */
export const EVE_NEXT_SERVICE_PREFIX = "/_eve_internal/eve";

const EVE_NEXT_PRODUCTION_ORIGIN_ENV = "EVE_NEXT_PRODUCTION_ORIGIN";
const EVE_NEXT_PRODUCTION_PORT_ENV = "EVE_NEXT_PRODUCTION_PORT";
const DEFAULT_EVE_NEXT_PRODUCTION_PORT = 4274;
const EVE_NAMED_AGENT_ROUTE_PREFIX = "/eve/agents";
const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

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
 * Configuration for one named eve agent mounted by {@link withEve}.
 */
export interface WithEveAgentOptions {
  /**
   * Path to the eve application root, relative to `process.cwd()` unless
   * absolute.
   */
  readonly root: string;
  /**
   * Build command for this generated eve Vercel service. Defaults to
   * {@link WithEveOptions.eveBuildCommand}, then a generated command that runs
   * the installed eve binary from this agent root.
   */
  readonly buildCommand?: string;
  /**
   * Private route namespace for this agent's legacy manually configured Vercel
   * service and non-Vercel production proxying.
   */
  readonly servicePrefix?: string;
}

/**
 * Map of agent names to roots or per-agent configuration.
 */
export type WithEveAgentsConfig = Record<string, string | WithEveAgentOptions>;

/**
 * Options for {@link withEve}.
 */
export interface WithEveOptions {
  /**
   * Maximum time in milliseconds to wait for the eve development server to
   * start, including waiting for another Next.js process to start it. Defaults
   * to 180000 (three minutes).
   */
  readonly devServerTimeoutMs?: number;
  /**
   * Path to the eve application root, relative to `process.cwd()` unless
   * absolute. Defaults to the Next.js app root.
   */
  readonly eveRoot?: string;
  /**
   * Named eve agents to mount under `/eve/agents/<name>/eve/v1/*`.
   *
   * Use this when one Next.js app needs to talk to multiple eve agents. When
   * set, do not also set {@link eveRoot}; the single-agent form remains the
   * shorthand for one unnamed agent mounted at `/eve/v1/*`.
   */
  readonly agents?: WithEveAgentsConfig;
  /**
   * Build command for the generated eve Vercel service. In multi-agent mode
   * this is the default for agents without their own `buildCommand`.
   *
   * When omitted, withEve generates a command that runs the installed eve
   * binary from the agent root.
   */
  readonly eveBuildCommand?: string;
  /**
   * Private route namespace for legacy manually configured Vercel services and
   * non-Vercel production proxying. Defaults to {@link EVE_NEXT_SERVICE_PREFIX}
   * (`/_eve_internal/eve`). `withEve` normalizes the prefix (adds a leading
   * slash, strips trailing slashes) and rejects a prefix that resolves to the
   * root route.
   */
  readonly servicePrefix?: string;
}

interface ResolvedEveNextAgent {
  readonly appRoot: string;
  readonly buildCommand: string;
  readonly localProductionPortOffset: number;
  readonly name?: string;
  readonly publicRoutePrefix: string;
  readonly servicePrefix: string;
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
    throw new Error("eve Next.js development server timeout must be a positive number.");
  }

  return timeoutMs;
}

function normalizeRoutePrefix(prefix: string): string {
  const prefixed = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const normalized = prefixed.replace(/\/+$/, "");

  if (normalized.length === 0) {
    throw new Error("eve Next.js service prefix cannot resolve to the root route.");
  }

  return normalized;
}

function joinRoutePrefix(prefix: string, path: string): string {
  return `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function createNamedAgentRoutePrefix(name: string): string {
  return joinRoutePrefix(EVE_NAMED_AGENT_ROUTE_PREFIX, name);
}

function createNamedAgentServicePrefix(basePrefix: string, name: string): string {
  return joinRoutePrefix(basePrefix, name);
}

function createAgentRewriteSource(publicRoutePrefix: string): string {
  return joinRoutePrefix(publicRoutePrefix, `${EVE_ROUTE_PREFIX}/:path+`);
}

function normalizeOrigin(origin: string): string {
  return new URL(origin.trim()).origin;
}

function readLocalProductionPort(portOffset: number): number {
  const configuredPort = process.env[EVE_NEXT_PRODUCTION_PORT_ENV];

  const basePort =
    configuredPort === undefined || configuredPort.trim().length === 0
      ? DEFAULT_EVE_NEXT_PRODUCTION_PORT
      : Number.parseInt(configuredPort, 10);

  if (
    configuredPort !== undefined &&
    configuredPort.trim().length > 0 &&
    String(basePort) !== configuredPort.trim()
  ) {
    throw new Error(`${EVE_NEXT_PRODUCTION_PORT_ENV} must be an integer between 1 and 65535.`);
  }

  const port = basePort + portOffset;
  if (port < 1 || port > 65_535) {
    throw new Error(`${EVE_NEXT_PRODUCTION_PORT_ENV} plus the eve agent count exceeds 65535.`);
  }

  return port;
}

function resolveProductionDestination(input: {
  readonly localProductionPortOffset: number;
  readonly servicePrefix: string;
}): {
  readonly destinationPrefix: string;
  readonly localServerOrigin?: string;
} {
  if (process.env.VERCEL) {
    return {
      destinationPrefix: input.servicePrefix,
    };
  }

  const configuredOrigin = process.env[EVE_NEXT_PRODUCTION_ORIGIN_ENV];

  if (configuredOrigin !== undefined && configuredOrigin.trim().length > 0) {
    return {
      destinationPrefix: joinRoutePrefix(normalizeOrigin(configuredOrigin), input.servicePrefix),
    };
  }

  const localServerOrigin = `http://127.0.0.1:${String(
    readLocalProductionPort(input.localProductionPortOffset),
  )}`;
  return {
    destinationPrefix: localServerOrigin,
    localServerOrigin,
  };
}

function createEveRewriteRule(input: {
  readonly destinationPrefix: string;
  readonly publicRoutePrefix: string;
}): EveNextRewriteRule {
  const source = createAgentRewriteSource(input.publicRoutePrefix);
  return {
    destination: joinRoutePrefix(input.destinationPrefix, `${EVE_ROUTE_PREFIX}/:path+`),
    source,
  };
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

function assertValidAgentName(name: string): void {
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `eve Next.js agent name ${JSON.stringify(
        name,
      )} is invalid. Use lowercase letters, numbers, underscores, or hyphens, starting with a letter or number.`,
    );
  }
}

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function createDefaultBuildCommand(input: {
  readonly agentRoot: string;
  readonly nextRoot: string;
}): string {
  const eveBinaryPath = toPosixPath(
    relative(input.agentRoot, resolveEveBinaryPath(input.nextRoot)),
  );
  return `node ${quoteShellArg(eveBinaryPath)} build`;
}

function normalizeAgentsConfig(
  options: WithEveOptions,
  nextRoot: string,
): readonly ResolvedEveNextAgent[] {
  const servicePrefixBase = normalizeRoutePrefix(options.servicePrefix ?? EVE_NEXT_SERVICE_PREFIX);
  const resolveBuildCommand = (agentRoot: string, buildCommand: string | undefined) =>
    buildCommand ?? options.eveBuildCommand ?? createDefaultBuildCommand({ agentRoot, nextRoot });

  if (options.agents === undefined) {
    const appRoot = resolveApplicationRoot(options.eveRoot);
    return [
      {
        appRoot,
        buildCommand: resolveBuildCommand(appRoot, undefined),
        localProductionPortOffset: 0,
        publicRoutePrefix: "",
        servicePrefix: servicePrefixBase,
      },
    ];
  }

  if (options.eveRoot !== undefined) {
    throw new Error("withEve cannot combine eveRoot with agents. Use one configuration form.");
  }

  const entries = Object.entries(options.agents);
  if (entries.length === 0) {
    throw new Error("withEve agents must contain at least one named eve agent.");
  }

  return entries.map(([name, config], index) => {
    assertValidAgentName(name);

    const agentConfig = typeof config === "string" ? { root: config } : config;
    const appRoot = resolveApplicationRoot(agentConfig.root);

    return {
      appRoot,
      buildCommand: resolveBuildCommand(appRoot, agentConfig.buildCommand),
      localProductionPortOffset: index,
      name,
      publicRoutePrefix: createNamedAgentRoutePrefix(name),
      servicePrefix: normalizeRoutePrefix(
        agentConfig.servicePrefix ?? createNamedAgentServicePrefix(servicePrefixBase, name),
      ),
    };
  });
}

/**
 * Wraps a Next.js config so same-origin eve endpoints proxy to a separate eve
 * service.
 *
 * In development, starts `eve dev --no-ui --port 0` for the eve app and
 * rewrites eve protocol endpoints to that local URL. In Vercel production,
 * writes Build Output service routes so Vercel sends eve protocol endpoints to
 * the eve service directly.
 * Outside Vercel production, serves an existing `.output/server/index.mjs` build
 * on a stable local port when present; otherwise set `EVE_NEXT_PRODUCTION_ORIGIN`
 * to the origin serving the eve service namespace.
 */
export function withEve<TConfig extends EveNextConfig>(
  configOrFunction: EveNextConfigInput<TConfig>,
  options: WithEveOptions = {},
): EveNextConfigFunction<TConfig> {
  const nextRoot = process.cwd();
  const devServerTimeoutMs = resolveDevServerTimeout(options.devServerTimeoutMs);
  const agents = normalizeAgentsConfig(options, nextRoot);

  return async function eveNextConfig(phase, context) {
    const nextConfig = await resolveNextConfig(configOrFunction, phase, context);
    const existingRewrites = nextConfig.rewrites;
    const configuredVercel = await ensureEveVercelOutputConfig({
      agents: agents.map((agent) => ({
        appRoot: agent.appRoot,
        buildCommand: agent.buildCommand,
        name: agent.name,
        publicRoutePrefix: agent.publicRoutePrefix,
        servicePrefix: agent.servicePrefix,
      })),
      nextRoot,
    });

    if (process.env.VERCEL) {
      return nextConfig;
    }

    const configuredAgentByName = new Map(
      configuredVercel.agents.map((agent) => [agent.name, agent] as const),
    );
    const agentsWithDestinations = agents.map((agent) => {
      const configuredAgent = configuredAgentByName.get(agent.name);
      const productionDestination = resolveProductionDestination({
        localProductionPortOffset: agent.localProductionPortOffset,
        servicePrefix: configuredAgent?.servicePrefix ?? agent.servicePrefix,
      });

      return {
        ...agent,
        productionDestination,
      };
    });

    return {
      ...nextConfig,
      async rewrites() {
        const [existing, eveRules] = await Promise.all([
          resolveExistingRewrites(existingRewrites),
          Promise.all(
            agentsWithDestinations.map(async (agent) => {
              const destinationPrefix = await resolveEveDestinationPrefix({
                appRoot: agent.appRoot,
                devServerTimeoutMs,
                logLabel: agent.name,
                phase,
                productionDestinationPrefix: agent.productionDestination.destinationPrefix,
                productionServerOrigin: agent.productionDestination.localServerOrigin,
              });

              return createEveRewriteRule({
                destinationPrefix,
                publicRoutePrefix: agent.publicRoutePrefix,
              });
            }),
          ),
        ]);

        return mergeRewriteRules(existing, eveRules);
      },
    };
  };
}
