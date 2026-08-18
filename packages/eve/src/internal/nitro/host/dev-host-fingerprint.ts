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
        ...new Set([
          ...(manifest.config.build?.externalDependencies ?? []),
          ...manifest.subagents.flatMap((subagent) =>
            subagent.configResolver === undefined
              ? (subagent.agent.config.build?.externalDependencies ?? [])
              : (subagent.configResolver.build?.externalDependencies ?? []),
          ),
        ]),
      ].sort((left, right) => left.localeCompare(right)),
      extensionScopes: agentNodes
        .flatMap((node) => node.extensionMounts)
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

async function readInstrumentationSource(host: PreparedDevelopmentApplicationHost): Promise<{
  readonly kind: "directory" | "file";
  readonly modules: readonly { readonly slot: string | null; readonly source: string }[];
} | null> {
  const paths = host.compiledArtifacts.instrumentationSourcePaths;
  const layout = host.compiledArtifacts.instrumentationLayout;
  if (paths === undefined || layout === undefined) {
    return null;
  }
  const sources = await Promise.all(paths.map(async (path) => await readFile(path, "utf8")));
  return {
    kind: layout.kind,
    modules: sources.map((source, index) => ({
      slot: layout.kind === "directory" ? (layout.slots[index] ?? null) : null,
      source,
    })),
  };
}
