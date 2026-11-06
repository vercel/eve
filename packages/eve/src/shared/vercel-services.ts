import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import { createEveServiceName } from "#internal/vercel/eve-service-contribution.js";
import { findConfiguredEveServiceEntry } from "#internal/vercel/vercel-service-config-operations.js";
import {
  createServiceConfigRecord,
  hasServices,
  parseVercelServicesConfig,
  readVercelJsonFile,
  type VercelServiceConfig,
} from "#internal/vercel/vercel-services-config.js";
import type { ResolvedFrameworkAgent } from "#shared/framework-agents.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
import { findClosestLinkedVercelDirectory } from "#shared/vercel-output-directory.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";

type VercelAgentTargets = Parameters<typeof assembleEveVercelServices>[0]["agents"];

/** Minimal Vercel Build Output config accepted from a framework adapter. */
export interface VercelBuildConfig {
  version?: number;
  routes?: unknown[];
  services?: Record<string, VercelServiceConfig>;
  [key: string]: unknown;
}

/** Authored root services own routing; otherwise merge the prepared agents into Build Output. */
export type EnsureEveVercelServicesConfigResult =
  | { readonly mode: "root" }
  | { readonly mode: "generated"; readonly agents: VercelAgentTargets };

/**
 * Prepare isolated eve service build roots unless vercel.json already owns services.
 * Authored root services must include every discovered agent; their routing is left untouched.
 */
export async function ensureEveVercelServicesConfig(input: {
  readonly agents: readonly ResolvedFrameworkAgent[];
  readonly eveBuildCommand?: string;
  readonly frameworkName: string;
  readonly hostRoot: string;
}): Promise<EnsureEveVercelServicesConfigResult> {
  const vercelDirectory = await findClosestLinkedVercelDirectory(input.hostRoot);
  const projectRoot = vercelDirectory === undefined ? input.hostRoot : dirname(vercelDirectory);
  // With a Vercel Root Directory, the host declaration wins over the repository's.
  const hostConfig = await readVercelJsonFile(join(input.hostRoot, VERCEL_JSON_FILE_NAME));
  const rootConfig =
    projectRoot === input.hostRoot || hasServices(hostConfig.services)
      ? hostConfig
      : await readVercelJsonFile(join(projectRoot, VERCEL_JSON_FILE_NAME));
  const rootServices = createServiceConfigRecord(rootConfig.services);

  if (hasServices(rootServices)) {
    for (const agent of input.agents) {
      if (findConfiguredEveServiceEntry(rootServices, agent) === undefined) {
        throw new Error(
          `${VERCEL_JSON_FILE_NAME} already defines services, so the eve ${input.frameworkName} integration cannot add a generated service for ${agent.name ?? "the default agent"}. Add ${agent.name === undefined ? "an eve service" : `the ${createEveServiceName(agent.name)} service`} (framework "eve") and its public route, or remove services from ${VERCEL_JSON_FILE_NAME}.`,
        );
      }
    }
    return { mode: "root" };
  }

  if (rootConfig.experimentalServices !== undefined) {
    console.warn(
      `[eve] ${VERCEL_JSON_FILE_NAME} defines experimentalServices, which Vercel no longer routes. The eve ${input.frameworkName} integration generates the stable services config automatically — remove experimentalServices from ${VERCEL_JSON_FILE_NAME}.`,
    );
  }

  const agents: VercelAgentTargets = input.agents.map((agent) => ({
    agent: {
      ...agent,
      workspaceMember: agent.name !== undefined,
      buildCommand:
        input.eveBuildCommand ??
        `node ${quoteVercelShellArgument(
          toVercelRelativePath(agent.appRoot, resolveEveBinaryPath(input.hostRoot)),
        )} build`,
    },
    target: {
      hostOutputDirectory: join(input.hostRoot, ".vercel", "output"),
      projectRoot: input.hostRoot,
    },
  }));
  const assembled = assembleEveVercelServices({ agents });
  await Promise.all(assembled.rootDirectories.map((root) => mkdir(root, { recursive: true })));
  return { mode: "generated", agents };
}

/**
 * Merge eve services and routes before filesystem routing using the shared Vercel assembler.
 * Authored eve services retain their configuration and gain the transport request-path route.
 * Invalid route or service data fails with a configuration path rather than a property-access error.
 */
export function mergeEveVercelConfig(
  existing: VercelBuildConfig | undefined,
  generated: Extract<EnsureEveVercelServicesConfigResult, { mode: "generated" }>,
): VercelBuildConfig {
  const config = parseVercelServicesConfig(existing ?? {}, "Vercel Build Output config.json");
  const assembled = assembleEveVercelServices({
    agents: generated.agents,
    routes: config.routes,
    services: createServiceConfigRecord(config.services),
  });
  return {
    version: 3,
    ...config,
    routes: [...assembled.routes],
    services: { ...assembled.services },
  };
}
