import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readDevelopmentEnvironmentHostValues } from "#cli/dev/environment.js";
import { computeChannelRouteRegistrations } from "#internal/nitro/host/channel-routes.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/nitro/host/types.js";

async function createDevelopmentHostFingerprintPayload(host: PreparedDevelopmentApplicationHost) {
  const manifest = host.compileResult.manifest;
  const agentNodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  return {
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
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function computeDevelopmentHostFingerprint(
  host: PreparedDevelopmentApplicationHost,
): Promise<string> {
  return fingerprint(await createDevelopmentHostFingerprintPayload(host));
}

/** Computes route-sensitive and route-independent fingerprints from one read pass. */
export async function computeDevelopmentHostFingerprints(
  host: PreparedDevelopmentApplicationHost,
): Promise<{
  readonly configuration: string;
  readonly host: string;
}> {
  const payload = await createDevelopmentHostFingerprintPayload(host);
  const { channels: _channels, ...configuration } = payload;
  return {
    configuration: fingerprint(configuration),
    host: fingerprint(payload),
  };
}

/** Fingerprints structural host inputs other than channel route topology. */
export async function computeDevelopmentHostConfigurationFingerprint(
  host: PreparedDevelopmentApplicationHost,
): Promise<string> {
  const { channels: _channels, ...configuration } =
    await createDevelopmentHostFingerprintPayload(host);
  return fingerprint(configuration);
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
