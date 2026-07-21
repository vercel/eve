import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
} from "#internal/application/paths.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
import { findClosestLinkedVercelDirectory } from "#shared/vercel-output-directory.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";
const EVE_SERVICE_NAME = "eve";
const EVE_SERVICE_ROUTE_SRC = `^${EVE_ROUTE_PREFIX}/(.*)$`;
const EVE_SERVICE_ROUTE_PATH = `${EVE_ROUTE_PREFIX}/$1`;
const EVE_VERCEL_SERVICES_DIRECTORY = ".eve/vercel-services";

interface VercelRequestPathTransform {
  readonly args: string;
  readonly op: "set";
  readonly type: "request.path";
}

interface VercelServiceRouteDestination {
  readonly service?: string;
  readonly type?: string;
}

interface VercelRouteConfig {
  readonly destination?: string | VercelServiceRouteDestination;
  readonly handle?: string;
  readonly src?: string;
  readonly transforms?: readonly VercelRequestPathTransform[];
  readonly [key: string]: unknown;
}

interface VercelServiceConfig {
  readonly framework?: string;
  readonly routes?: readonly VercelRouteConfig[];
  readonly [key: string]: unknown;
}

interface VercelNamedServiceConfig extends VercelServiceConfig {
  readonly name?: string;
}

type VercelServicesCollection =
  | Record<string, VercelServiceConfig>
  | readonly VercelNamedServiceConfig[];

interface VercelJsonConfig {
  readonly experimentalServices?: unknown;
  readonly services?: VercelServicesCollection;
  readonly [key: string]: unknown;
}

/**
 * The top-level Vercel Build Output route that sends eve transport requests to
 * the generated eve service.
 */
export type EveVercelServiceRoute = {
  readonly destination: {
    readonly service: string;
    readonly type: "service";
  };
  readonly src: string;
};

/**
 * A service-scoped route carrying the `request.path` transform that pins the
 * path the eve runtime observes to the eve transport namespace.
 */
export type EveVercelServiceRequestPathRoute = {
  readonly src: string;
  readonly transforms: readonly [VercelRequestPathTransform];
};

/**
 * The generated eve service entry written into the Vercel Build Output
 * `services` record.
 */
export type EveVercelGeneratedService = {
  readonly buildCommand: string;
  readonly framework: "eve";
  readonly routes: readonly VercelRouteConfig[];
  readonly root: string;
};

/**
 * Minimal shape of the Nitro Vercel build-output config the module merges the
 * generated eve service into.
 */
export interface NitroVercelBuildConfig {
  version?: number;
  routes?: unknown[];
  services?: Record<string, VercelServiceConfig>;
  [key: string]: unknown;
}

/**
 * Result of {@link ensureEveVercelServicesConfig}: `root` when `vercel.json`
 * already declares stable services (the user owns routing; nothing is
 * generated), `generated` with the service record to merge into the Nitro
 * Vercel build config otherwise.
 */
export type EnsureEveVercelServicesConfigResult =
  | { readonly mode: "root" }
  | {
      readonly mode: "generated";
      readonly services: Record<string, EveVercelGeneratedService>;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPosixRelative(from: string, to: string): string {
  const relativePath = relative(from, to);
  return relativePath.length === 0 ? "." : relativePath.replaceAll("\\", "/");
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isNamedServiceConfigArray(
  services: VercelServicesCollection,
): services is readonly VercelNamedServiceConfig[] {
  return Array.isArray(services);
}

function createServiceConfigRecord(
  services: VercelServicesCollection | undefined,
): Record<string, VercelServiceConfig> {
  if (services === undefined) {
    return {};
  }

  if (isNamedServiceConfigArray(services)) {
    const record: Record<string, VercelServiceConfig> = {};

    for (const service of services) {
      if (typeof service.name === "string" && service.name.trim().length > 0) {
        const { name, ...serviceConfig } = service;
        record[name] = serviceConfig;
      }
    }

    return record;
  }

  return services;
}

function normalizeVercelJsonConfig(value: unknown): VercelJsonConfig {
  if (!isRecord(value)) {
    throw new Error(`${VERCEL_JSON_FILE_NAME} must contain a JSON object.`);
  }

  const services = value.services;

  if (
    services !== undefined &&
    !isRecord(services) &&
    !(
      Array.isArray(services) &&
      services.every(
        (service) =>
          isRecord(service) && typeof service.name === "string" && service.name.trim().length > 0,
      )
    )
  ) {
    throw new Error(
      `${VERCEL_JSON_FILE_NAME} services must be a JSON object or named service array.`,
    );
  }

  return value as VercelJsonConfig;
}

async function readVercelJsonConfig(path: string): Promise<VercelJsonConfig> {
  try {
    return normalizeVercelJsonConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function findEveService(
  services: Record<string, VercelServiceConfig>,
): VercelServiceConfig | undefined {
  return Object.values(services).find((service) => service.framework === "eve");
}

function assertRootServicesIncludeEve(services: Record<string, VercelServiceConfig>): void {
  if (findEveService(services) === undefined) {
    throw new Error(
      `${VERCEL_JSON_FILE_NAME} already defines services, so the eve Nuxt module cannot add a generated eve service. Add an eve service (framework "eve") and a rewrite from ${EVE_ROUTE_PREFIX}/(.*) to it in ${VERCEL_JSON_FILE_NAME}, or remove services from ${VERCEL_JSON_FILE_NAME}.`,
    );
  }
}

/**
 * Build the top-level Build Output route that exposes the eve service on the
 * eve transport namespace (`/eve/v1/*`).
 */
export function createEveServiceRoute(
  serviceName: string = EVE_SERVICE_NAME,
): EveVercelServiceRoute {
  return {
    destination: {
      service: serviceName,
      type: "service",
    },
    src: EVE_SERVICE_ROUTE_SRC,
  };
}

/**
 * Build the eve service's own route that sets `request.path` so the eve
 * runtime observes the transport path regardless of how the platform routed
 * the request into the service.
 */
export function createEveServiceRequestPathRoute(): EveVercelServiceRequestPathRoute {
  return {
    src: EVE_SERVICE_ROUTE_SRC,
    transforms: [
      {
        args: EVE_SERVICE_ROUTE_PATH,
        op: "set",
        type: "request.path",
      },
    ],
  };
}

function isEveServiceRoute(route: VercelRouteConfig, serviceName: string): boolean {
  const destination = route.destination;

  return (
    route.src === EVE_SERVICE_ROUTE_SRC &&
    isRecord(destination) &&
    destination.type === "service" &&
    destination.service === serviceName
  );
}

function insertEveServiceRoute(routes: readonly unknown[], serviceName: string): unknown[] {
  const routesWithoutEveRoute = routes.filter(
    (route) => !(isRecord(route) && isEveServiceRoute(route, serviceName)),
  );
  const filesystemRouteIndex = routesWithoutEveRoute.findIndex(
    (route) => isRecord(route) && route.handle === "filesystem",
  );

  if (filesystemRouteIndex === -1) {
    return [createEveServiceRoute(serviceName), ...routesWithoutEveRoute];
  }

  return [
    ...routesWithoutEveRoute.slice(0, filesystemRouteIndex),
    createEveServiceRoute(serviceName),
    ...routesWithoutEveRoute.slice(filesystemRouteIndex),
  ];
}

function insertEveServiceRequestPathRoute(
  routes: readonly VercelRouteConfig[] | undefined,
): readonly VercelRouteConfig[] {
  const routesWithoutGeneratedRoute = (routes ?? []).filter(
    (route) => route.src !== EVE_SERVICE_ROUTE_SRC,
  );

  return [createEveServiceRequestPathRoute(), ...routesWithoutGeneratedRoute];
}

function createGeneratedServiceBuild(input: {
  readonly appRoot: string;
  readonly eveBuildCommand?: string;
  readonly nuxtRoot: string;
}): { readonly buildCommand: string; readonly root: string; readonly rootDirectory: string } {
  const rootDirectory = join(input.nuxtRoot, EVE_VERCEL_SERVICES_DIRECTORY, EVE_SERVICE_NAME);
  const outputDirectory = join(rootDirectory, ".vercel", "output");
  const hostOutputDirectory = join(input.nuxtRoot, ".vercel", "output");
  const workingDirectory = toPosixRelative(rootDirectory, input.appRoot);
  const configuredOutputDirectory = toPosixRelative(input.appRoot, outputDirectory);
  const configuredHostOutputDirectory = toPosixRelative(input.appRoot, hostOutputDirectory);
  const buildCommand =
    input.eveBuildCommand ??
    `node ${quoteShellArgument(toPosixRelative(input.appRoot, resolveEveBinaryPath(input.nuxtRoot)))} build`;

  return {
    buildCommand: `cd ${quoteShellArgument(workingDirectory)} && export ${EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(configuredOutputDirectory)} && export ${EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(configuredHostOutputDirectory)} && ${buildCommand}`,
    root: toPosixRelative(input.nuxtRoot, rootDirectory),
    rootDirectory,
  };
}

/**
 * Resolve the stable Vercel services configuration for a Nuxt + eve
 * deployment.
 *
 * When `vercel.json` (looked up from the linked Vercel project root, falling
 * back to the Nuxt root) already declares stable `services`, it must include
 * an eve service and the module generates nothing. Otherwise this prepares a
 * generated eve service — creating its isolated build root under
 * `.eve/vercel-services/eve` so the eve build output cannot collide with the
 * Nuxt Build Output — and returns the service record plus the public service
 * route for the caller to merge into the Nitro Vercel build config. A legacy
 * `experimentalServices` field is ignored with a migration warning: Vercel no
 * longer routes it.
 */
export async function ensureEveVercelServicesConfig(input: {
  readonly appRoot: string;
  readonly eveBuildCommand?: string;
  readonly nuxtRoot: string;
}): Promise<EnsureEveVercelServicesConfigResult> {
  const vercelDirectory = await findClosestLinkedVercelDirectory(input.nuxtRoot);
  const projectRoot = vercelDirectory === undefined ? input.nuxtRoot : dirname(vercelDirectory);
  const rootVercelConfig = await readVercelJsonConfig(join(projectRoot, VERCEL_JSON_FILE_NAME));
  const rootServices = createServiceConfigRecord(rootVercelConfig.services);

  if (Object.keys(rootServices).length > 0) {
    assertRootServicesIncludeEve(rootServices);
    return { mode: "root" };
  }

  if (rootVercelConfig.experimentalServices !== undefined) {
    console.warn(
      `[eve] ${VERCEL_JSON_FILE_NAME} defines experimentalServices, which Vercel no longer routes. The eve Nuxt module now generates the stable services config automatically — remove experimentalServices from ${VERCEL_JSON_FILE_NAME}.`,
    );
  }

  const generatedServiceBuild = createGeneratedServiceBuild(input);
  await mkdir(generatedServiceBuild.rootDirectory, { recursive: true });

  return {
    mode: "generated",
    services: {
      [EVE_SERVICE_NAME]: {
        buildCommand: generatedServiceBuild.buildCommand,
        framework: "eve",
        routes: [createEveServiceRequestPathRoute()],
        root: generatedServiceBuild.root,
      },
    },
  };
}

/**
 * Merge the generated eve service and its public route into a Nitro Vercel
 * build config (`nitro.vercel.config`).
 *
 * The service route is inserted before an existing `handle: "filesystem"`
 * route, or prepended when none exists — Nitro appends its own generated
 * routes (including the filesystem handle) after this config's routes, so the
 * eve route always resolves before the Nuxt app's filesystem routing. An eve
 * service already configured by the user is preserved and only gains the
 * `request.path` route; everything else passes through untouched.
 */
export function mergeEveVercelConfig(
  existing: NitroVercelBuildConfig | undefined,
  generated: Extract<EnsureEveVercelServicesConfigResult, { mode: "generated" }>,
): NitroVercelBuildConfig {
  const existingServices = existing?.services ?? {};
  const configuredEveEntry = Object.entries(existingServices).find(
    ([name, service]) => name === EVE_SERVICE_NAME || service.framework === "eve",
  );
  const serviceName = configuredEveEntry?.[0] ?? EVE_SERVICE_NAME;
  const services = configuredEveEntry
    ? {
        ...existingServices,
        [serviceName]: {
          ...configuredEveEntry[1],
          routes: insertEveServiceRequestPathRoute(configuredEveEntry[1].routes),
        },
      }
    : { ...existingServices, ...generated.services };

  return {
    version: 3,
    ...existing,
    routes: insertEveServiceRoute(existing?.routes ?? [], serviceName),
    services,
  };
}
