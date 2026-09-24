import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  createExternalResourcesSnapshot,
  type ExternalResource,
  type ExternalResourcesSnapshot,
} from "#internal/external-resources-snapshot.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export const CONNECT_MANIFEST_FILENAME = "vercel-connect-manifest.json";

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
  for (const channel of manifest.channelRoutes.effective) {
    const credentials = channel.vercelConnect?.requirement;
    if (credentials === undefined || channel.manifest === undefined) continue;
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
  readonly appRoot: string;
  readonly generatorVersion: string;
  readonly manifest: CompiledAgentManifest;
  readonly outputDirectory: string;
  readonly publicRoutePrefix?: string;
}): Promise<void> {
  const snapshot = buildExternalResourcesSnapshot(input);
  const manifest = await createConnectManifest({ appRoot: input.appRoot, snapshot });
  if (manifest === undefined) return;
  await mkdir(input.outputDirectory, { recursive: true });
  await writeFile(
    join(input.outputDirectory, CONNECT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export async function createConnectManifest(input: {
  readonly appRoot: string;
  readonly snapshot: ExternalResourcesSnapshot;
}): Promise<JsonObject | undefined> {
  if (input.snapshot.resources.length === 0) return undefined;
  const require = createRequire(join(input.appRoot, "package.json"));
  let modulePath: string;
  try {
    modulePath = require.resolve("@vercel/connect/manifest");
  } catch {
    throw new Error(
      "Connect-backed resources require @vercel/connect with manifest compiler support. Install or update @vercel/connect, then rerun `eve build`.",
    );
  }
  try {
    const compiler = (await import(pathToFileURL(modulePath).href)) as {
      readonly experimental_createConnectManifestFromEveResources?: (snapshot: unknown) => unknown;
    };
    if (typeof compiler.experimental_createConnectManifestFromEveResources !== "function") {
      throw new TypeError("missing experimental_createConnectManifestFromEveResources export");
    }
    return parseJsonObject(
      compiler.experimental_createConnectManifestFromEveResources(input.snapshot),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to create the Connect manifest: ${detail}. Update @vercel/connect and rerun \`eve build\`.`,
    );
  }
}
