import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { JsonObject } from "#shared/json.js";

export const VERCEL_CONNECT_MANIFEST_FILENAME = "vercel-connect-manifest.json";
export const VERCEL_CONNECT_MANIFEST_KIND = "vercel-connect-manifest";
export const VERCEL_CONNECT_MANIFEST_SCHEMA_VERSION = 1;

export type VercelConnectTarget =
  | { readonly mode: "direct"; readonly locator: string }
  | { readonly mode: "binding"; readonly reference: string };

export interface VercelConnectRequirement {
  readonly target: VercelConnectTarget;
  readonly connector: {
    readonly type: string;
    readonly configuration?: JsonObject;
  };
  readonly resource?: { readonly protocol: "mcp" | "openapi"; readonly url: string };
  readonly providerConfiguration?: { readonly format: string; readonly path: string };
  readonly access: { readonly principalTypes: readonly ("app" | "user")[] };
  readonly triggers?: readonly { readonly method: string; readonly path: string }[];
  readonly uses: readonly {
    readonly kind: "channel" | "connection";
    readonly name: string;
    readonly logicalPath: string;
  }[];
}

export interface VercelConnectManifest {
  readonly kind: typeof VERCEL_CONNECT_MANIFEST_KIND;
  readonly schemaVersion: typeof VERCEL_CONNECT_MANIFEST_SCHEMA_VERSION;
  readonly generator: { readonly name: "eve"; readonly version: string };
  readonly requirements: readonly VercelConnectRequirement[];
}

export function buildVercelConnectRequirements(manifest: {
  readonly connections: readonly Pick<
    CompiledAgentManifest["connections"][number],
    "connectionName" | "logicalPath" | "protocol" | "url" | "vercelConnect"
  >[];
  readonly channelRoutes: {
    readonly effective: readonly Pick<
      CompiledAgentManifest["channelRoutes"]["effective"][number],
      "logicalPath" | "method" | "name" | "urlPath" | "vercelConnect"
    >[];
  };
}): readonly VercelConnectRequirement[] {
  return [
    ...manifest.connections.flatMap((connection) => {
      const vercelConnect = connection.vercelConnect;
      if (
        vercelConnect?.connectorType === undefined ||
        vercelConnect.principalTypes === undefined
      ) {
        return [];
      }
      return [
        {
          target: { mode: "direct" as const, locator: vercelConnect.connector },
          connector: { type: vercelConnect.connectorType },
          access: { principalTypes: vercelConnect.principalTypes },
          resource: { protocol: connection.protocol, url: connection.url },
          uses: [
            {
              kind: "connection" as const,
              name: connection.connectionName,
              logicalPath: connection.logicalPath,
            },
          ],
        },
      ];
    }),
    ...manifest.channelRoutes.effective.flatMap((channel) => {
      const vercelConnect = channel.vercelConnect;
      if (
        vercelConnect?.connectorType === undefined ||
        vercelConnect.principalTypes === undefined
      ) {
        return [];
      }
      return [
        {
          target: { mode: "direct" as const, locator: vercelConnect.connector },
          connector: { type: vercelConnect.connectorType },
          access: { principalTypes: vercelConnect.principalTypes },
          triggers: [{ method: channel.method, path: channel.urlPath }],
          uses: [
            { kind: "channel" as const, name: channel.name, logicalPath: channel.logicalPath },
          ],
        },
      ];
    }),
  ];
}

export async function emitVercelConnectManifest(input: {
  readonly generatorVersion: string;
  readonly manifest: CompiledAgentManifest;
  readonly outputDirectory: string;
}): Promise<void> {
  const manifest = createVercelConnectManifest({
    generatorVersion: input.generatorVersion,
    requirements: buildVercelConnectRequirements(input.manifest),
  });
  if (manifest === undefined) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(input.outputDirectory, { recursive: true });
  await writeFile(
    join(input.outputDirectory, VERCEL_CONNECT_MANIFEST_FILENAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

export function createVercelConnectManifest(input: {
  readonly generatorVersion: string;
  readonly requirements: readonly VercelConnectRequirement[];
}): VercelConnectManifest | undefined {
  if (input.requirements.length === 0) return undefined;
  return {
    kind: VERCEL_CONNECT_MANIFEST_KIND,
    schemaVersion: VERCEL_CONNECT_MANIFEST_SCHEMA_VERSION,
    generator: { name: "eve", version: input.generatorVersion },
    requirements: input.requirements,
  };
}
