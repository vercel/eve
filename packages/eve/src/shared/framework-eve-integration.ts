import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { findEveProjectContext } from "#internal/project-context.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import {
  createEveServiceName,
  type EveVercelAgentTarget,
} from "#internal/vercel/eve-service-contribution.js";
import { findConfiguredEveServiceEntry } from "#internal/vercel/vercel-service-config-operations.js";
import {
  createServiceConfigRecord,
  hasServices,
  readVercelJsonFile,
  type VercelServicesConfig,
} from "#internal/vercel/vercel-services-config.js";
import {
  resolveSharedEveDevServer,
  type EveFrameworkHost,
  type EveProcessHandle,
} from "#shared/framework-eve-server.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
import { readOptionalFile } from "#shared/read-optional-file.js";
import { findClosestLinkedVercelDirectory } from "#shared/vercel-output-directory.js";

const EVE_BASE_URL_ENV = "EVE_BASE_URL";

/** Validate `EVE_BASE_URL` and reduce it to its origin, when set. */
export function readEveBaseUrlOrigin(): string | undefined {
  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl === undefined || configuredEveBaseUrl.length === 0) {
    return undefined;
  }
  const url = URL.parse(configuredEveBaseUrl);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(
      `${EVE_BASE_URL_ENV} must be an absolute http(s) URL such as http://127.0.0.1:2000, received "${configuredEveBaseUrl}".`,
    );
  }
  return url.origin;
}

/**
 * One eve agent mounted by a framework integration. `publicRoutePrefix` is
 * empty for a standalone agent, which mounts at `/eve/v1`.
 */
export type EveFrameworkAgent = Omit<EveVercelAgentTarget, "buildCommand" | "devCommand">;

/**
 * Resolve the agents an eve project mounts: a standalone `agent/`, a flat
 * agent root, or every member of an `agents/` workspace at `/eve/<name>`.
 */
export async function resolveEveAgents(projectRoot: string): Promise<readonly EveFrameworkAgent[]> {
  const context = await findEveProjectContext(projectRoot);
  if (
    context?.kind === "workspace" &&
    context.workspace.root === projectRoot &&
    context.workspace.members.length > 0
  ) {
    return context.workspace.members.map((member) => ({
      appRoot: member.appRoot,
      name: member.name,
      publicRoutePrefix: `/eve/${member.name}`,
      workspaceMember: true,
    }));
  }
  return [{ appRoot: projectRoot, publicRoutePrefix: "" }];
}

/**
 * Resolve the dev server one agent's routes proxy to: the `EVE_BASE_URL` env
 * var if set, then a healthy shared server already running for the agent, then
 * a freshly spawned `eve dev --no-ui --port 0`. `process` is set only when
 * this call spawned the server, so the caller owns its shutdown.
 */
export async function resolveEveAgentDevServer(
  agent: EveFrameworkAgent,
  host: EveFrameworkHost,
  timeoutMs: number | undefined,
): Promise<EveProcessHandle> {
  const configuredOrigin = readEveBaseUrlOrigin();
  if (configuredOrigin !== undefined) {
    return { origin: configuredOrigin };
  }

  return resolveSharedEveDevServer({
    appRoot: agent.appRoot,
    host,
    logLabel: agent.name,
    timeoutMs,
    workspaceAgentName: agent.name,
  });
}

/**
 * Add each agent's generated Vercel service and routes to the Build Output
 * config `readConfig` returns. Returns `undefined` when the project's
 * `vercel.json` or `vercel.ts` declares the services instead.
 */
export async function addEveVercelServices(
  readConfig: () => Promise<VercelServicesConfig>,
  input: {
    readonly agents: readonly EveFrameworkAgent[];
    readonly eveBuildCommand: string | undefined;
    readonly host: EveFrameworkHost;
    readonly hostRoot: string;
  },
): Promise<VercelServicesConfig | undefined> {
  // Config lives at the host root, where the build output is written, not at
  // the eve project root that `eveRoot` can move elsewhere. With a Vercel Root
  // Directory the linked project root holds it instead.
  const vercelDirectory = await findClosestLinkedVercelDirectory(input.hostRoot);
  const linkedRoot = vercelDirectory === undefined ? input.hostRoot : dirname(vercelDirectory);
  for (const root of new Set([input.hostRoot, linkedRoot])) {
    if ((await readOptionalFile(join(root, "vercel.ts")))?.includes("eve/vercel")) {
      return undefined;
    }
  }

  // A vercel.json at the host root wins; otherwise the linked project root's
  // config describes the deploy.
  const hostConfig = await readVercelJsonFile(join(input.hostRoot, "vercel.json"));
  const rootConfig =
    linkedRoot === input.hostRoot || hasServices(hostConfig.services)
      ? hostConfig
      : await readVercelJsonFile(join(linkedRoot, "vercel.json"));
  const rootServices = createServiceConfigRecord(rootConfig.services);
  if (Object.keys(rootServices).length > 0) {
    for (const agent of input.agents) {
      if (findConfiguredEveServiceEntry(rootServices, agent) !== undefined) {
        continue;
      }
      // Named agents must use the exact generated service name, which can be
      // hashed when the agent name has characters Vercel rejects.
      const expectedService =
        agent.name === undefined
          ? `an eve service (framework "eve")`
          : `an eve service named "${createEveServiceName(agent.name)}" (framework "eve")`;
      throw new Error(
        `vercel.json already defines services, so the eve ${input.host.label} integration cannot add a generated eve service for ${agent.name ?? "the default agent"}. Add ${expectedService} to vercel.json, or remove services from vercel.json.`,
      );
    }
    return undefined;
  }

  if (rootConfig.experimentalServices !== undefined) {
    console.warn(
      `[eve] vercel.json defines experimentalServices, which Vercel no longer routes. The eve ${input.host.label} integration now generates the stable services config automatically — remove experimentalServices from vercel.json.`,
    );
  }

  const config = await readConfig();
  const assembled = assembleEveVercelServices({
    agents: input.agents.map((agent) => ({
      agent: {
        ...agent,
        buildCommand:
          input.eveBuildCommand ??
          `node ${quoteVercelShellArgument(
            toVercelRelativePath(agent.appRoot, resolveEveBinaryPath(agent.appRoot)),
          )} build`,
      },
      target: {
        hostOutputDirectory: join(input.hostRoot, ".vercel", "output"),
        projectRoot: input.hostRoot,
      },
    })),
    routes: config.routes,
    services: createServiceConfigRecord(config.services),
  });
  await Promise.all(
    assembled.rootDirectories.map((directory) => mkdir(directory, { recursive: true })),
  );
  return { ...config, routes: assembled.routes, services: assembled.services };
}
