import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readDevelopmentEnvironmentHostValues } from "#cli/dev/environment.js";
import { computeChannelRouteRegistrations } from "#internal/nitro/host/channel-routes.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

export async function computeDevelopmentHostFingerprint(
  host: PreparedDevelopmentApplicationHost,
): Promise<string> {
  const manifest = host.compileResult.manifest;
  const agentNodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  const payload = {
    agentName: manifest.config.name,
    bundler: {
      externalDependencies: [
        ...new Set(agentNodes.flatMap((node) => node.config.build?.externalDependencies ?? [])),
      ].sort((left, right) => left.localeCompare(right)),
      extensionScopes: (manifest.extensionMounts ?? [])
        .map((mount) => ({
          packageNamespace: mount.packageNamespace,
          sourceRoot: mount.sourceRoot,
        }))
        .sort((left, right) => left.sourceRoot.localeCompare(right.sourceRoot)),
      sandboxBackends: [
        ...new Set(
          agentNodes
            .map((node) => node.sandbox?.backendName)
            .filter((backendName): backendName is string => backendName !== undefined),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    },
    channels: computeChannelRouteRegistrations(host),
    environment: readDevelopmentEnvironmentHostValues(host.appRoot),
    instrumentation: await readInstrumentationSource(host),
    workflow: {
      enabled: agentNodes.some((node) => node.workflowTool !== undefined),
      world: manifest.config.experimental?.workflow?.world ?? "local",
    },
  };

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function readInstrumentationSource(
  host: PreparedDevelopmentApplicationHost,
): Promise<string | null> {
  const path = host.compiledArtifacts.instrumentationSourcePath;
  if (path === undefined) {
    return null;
  }
  return await readFile(path, "utf8");
}
