import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createExternalResourcesSnapshot,
  type ExternalResource,
  type ExternalResourcesSnapshot,
} from "#internal/external-resources-snapshot.js";
import { createConnectManifest } from "#internal/connect-manifest.js";

const CONNECT_MANIFEST_FILENAME = "vercel-connect-manifest.json";

export function buildExternalResourcesSnapshot(input: {
  readonly generatorVersion: string;
  readonly manifest: CompiledAgentManifest;
  readonly publicRoutePrefix?: string;
}): ExternalResourcesSnapshot {
  const resources: ExternalResource[] = [];
  const manifests = [input.manifest, ...input.manifest.subagents.map((subagent) => subagent.agent)];
  for (const manifest of manifests) {
    collectExternalResources(manifest, resources, input.publicRoutePrefix);
  }
  return createExternalResourcesSnapshot({ generatorVersion: input.generatorVersion, resources });
}

function collectExternalResources(
  manifest: Pick<CompiledAgentManifest, "channelRoutes" | "connections">,
  resources: ExternalResource[],
  publicRoutePrefix: string | undefined,
): void {
  for (const connection of manifest.connections) {
    const credentials = connection.vercelConnect?.requirement;
    if (credentials === undefined) continue;
    if (connection.protocol === "openapi" && connection.url.length === 0) {
      throw new Error(
        `Connect-backed OpenAPI connection "${connection.connectionName}" must set baseUrl explicitly.`,
      );
    }
    resources.push({
      credentials,
      kind: "connection",
      logicalPath: connection.logicalPath,
      name: connection.connectionName,
      protocol: { type: connection.protocol, url: connection.url },
    });
  }
  const channelPaths = new Set<string>();
  for (const channel of manifest.channelRoutes.effective) {
    const credentials = channel.vercelConnect?.requirement;
    if (credentials === undefined) continue;
    const key = JSON.stringify([channel.name, channel.urlPath]);
    if (channelPaths.has(key)) continue;
    channelPaths.add(key);
    resources.push({
      credentials,
      kind: "channel",
      logicalPath: channel.logicalPath,
      manifest: channel.manifest,
      name: channel.name,
      route: { path: `${publicRoutePrefix ?? ""}${channel.urlPath}` },
    });
  }
}

export async function emitConnectManifest(input: {
  readonly generatorVersion: string;
  readonly manifest: CompiledAgentManifest;
  readonly outputDirectory: string;
  readonly publicRoutePrefix?: string;
}): Promise<void> {
  const snapshot = buildExternalResourcesSnapshot(input);
  const manifest = createConnectManifest(snapshot);
  if (manifest === undefined) return;
  await mkdir(input.outputDirectory, { recursive: true });
  await writeFile(
    join(input.outputDirectory, CONNECT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
