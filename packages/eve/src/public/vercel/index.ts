import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { resolveEveProjectContext } from "#internal/project-context.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import {
  createEveServiceName,
  createEveServiceRouteSrc,
} from "#internal/vercel/eve-service-contribution.js";
import {
  createServiceConfigRecord,
  type VercelServicesConfig,
} from "#internal/vercel/vercel-services-config.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";

/** A route accepted by eve's Vercel configuration composer. */
export interface EveVercelRouteConfig {
  readonly destination?: string | { readonly service?: string; readonly type?: string };
  readonly handle?: string;
  readonly src?: string;
  readonly transforms?: readonly Record<string, unknown>[];
  readonly [key: string]: unknown;
}

/** A service accepted by eve's Vercel configuration composer. */
export interface EveVercelServiceConfig {
  readonly buildCommand?: string;
  readonly entrypoint?: string;
  readonly framework?: string;
  readonly mount?: string | { readonly path?: string; readonly subdomain?: string };
  readonly routes?: readonly EveVercelRouteConfig[];
  readonly root?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

/** The portion of a programmatic Vercel configuration composed by eve. */
export interface EveVercelConfig {
  readonly experimentalServices?: unknown;
  readonly experimentalServicesV2?: unknown;
  readonly routes?: readonly EveVercelRouteConfig[];
  readonly services?:
    | Readonly<Record<string, EveVercelServiceConfig>>
    | readonly (EveVercelServiceConfig & { readonly name: string })[];
  readonly [key: string]: unknown;
}

/** Options for composing an eve workspace into a programmatic Vercel configuration. */
export interface WithEveOptions {
  /** Eve workspace root. Defaults to the directory evaluating `vercel.ts`. */
  readonly root?: string;
}

function toInternalConfig(config: EveVercelConfig): VercelServicesConfig {
  return config as unknown as VercelServicesConfig;
}

function assertComposableConfig(config: EveVercelConfig, agentNames: readonly string[]): void {
  if (config.experimentalServices !== undefined || config.experimentalServicesV2 !== undefined) {
    throw new Error(
      "withEve does not support experimentalServices. Use services or remove the obsolete configuration.",
    );
  }

  const internalConfig = toInternalConfig(config);
  const services = createServiceConfigRecord(internalConfig.services);
  for (const name of agentNames) {
    const serviceName = createEveServiceName(name);
    if (services[serviceName] !== undefined) {
      throw new Error(
        `Vercel service ${JSON.stringify(serviceName)} is reserved for eve workspace agent ${JSON.stringify(name)}.`,
      );
    }

    const routeSrc = createEveServiceRouteSrc(`/${name}`);
    if (config.routes?.some((route) => route.src === routeSrc)) {
      throw new Error(
        `Vercel route ${JSON.stringify(routeSrc)} is reserved for eve workspace agent ${JSON.stringify(name)}.`,
      );
    }
  }
}

/**
 * Add a hostless eve workspace's generated agent services and transport routes to `vercel.ts`.
 *
 * The returned object is a plain Vercel configuration. Vercel resolves it before independently
 * building the authored services and each generated eve agent service.
 */
export async function withEve<TConfig extends EveVercelConfig>(
  config: TConfig,
  options: WithEveOptions = {},
): Promise<
  Omit<TConfig, "routes" | "services"> & {
    readonly routes: readonly EveVercelRouteConfig[];
    readonly services: Readonly<Record<string, EveVercelServiceConfig>>;
  }
> {
  const root = resolve(options.root ?? process.cwd());
  const context = await resolveEveProjectContext(root);
  if (context.kind !== "workspace" || context.workspace.root !== root) {
    throw new Error(`withEve must run at an eve workspace root; received ${root}.`);
  }

  const { workspace } = context;
  const agentNames = workspace.members.map((member) => member.name);
  const generatedServiceNames = new Set(agentNames.map(createEveServiceName));
  assertComposableConfig(config, agentNames);

  const outputDirectory = join(root, ".vercel", "output");
  const internalConfig = toInternalConfig(config);
  const assembled = assembleEveVercelServices({
    agents: workspace.members.map((member) => ({
      agent: {
        appRoot: member.appRoot,
        buildCommand: `node ${quoteVercelShellArgument(
          toVercelRelativePath(member.appRoot, resolveEveBinaryPath(member.appRoot)),
        )} build`,
        name: member.name,
        publicRoutePrefix: `/${member.name}`,
        workspaceMember: true,
      },
      target: {
        hostOutputDirectory: outputDirectory,
        projectRoot: root,
      },
    })),
    routes: internalConfig.routes,
    services: createServiceConfigRecord(internalConfig.services),
  });

  await Promise.all(
    assembled.rootDirectories.map((directory) => mkdir(directory, { recursive: true })),
  );

  const services = Object.fromEntries(
    Object.entries(assembled.services).map(([name, service]) => {
      if (!generatedServiceNames.has(name)) {
        return [name, service];
      }
      const { routePrefix: _routePrefix, ...vercelSourceService } = service;
      return [name, vercelSourceService];
    }),
  );

  return {
    ...config,
    routes: assembled.routes as readonly EveVercelRouteConfig[],
    services: services as Readonly<Record<string, EveVercelServiceConfig>>,
  };
}
