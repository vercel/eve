import type { CompiledAgentManifest } from "#compiler/manifest.js";

export const VERCEL_CONNECT_MANIFEST_KIND = "vercel-connect-manifest";
export const VERCEL_CONNECT_MANIFEST_VERSION = 1;

export interface VercelConnectRequirement {
  readonly reference: string;
  readonly connector: {
    readonly type: string;
    readonly configuration?: Readonly<Record<string, unknown>>;
  };
  readonly access: {
    readonly principalTypes: readonly ("app" | "user")[];
  };
}

interface VercelConnectManifestRequirement extends VercelConnectRequirement {
  readonly resource?: { readonly protocol: "mcp" | "openapi"; readonly url: string };
  readonly triggers?: readonly { readonly method: string; readonly path: string }[];
  readonly uses: readonly {
    readonly kind: "channel" | "connection";
    readonly logicalPath: string;
    readonly name: string;
  }[];
}

export interface VercelConnectManifest {
  readonly kind: typeof VERCEL_CONNECT_MANIFEST_KIND;
  readonly schemaVersion: typeof VERCEL_CONNECT_MANIFEST_VERSION;
  readonly generator: { readonly name: "eve"; readonly version: string };
  readonly requirements: readonly VercelConnectManifestRequirement[];
}

export function createVercelConnectManifest(input: {
  readonly manifest: CompiledAgentManifest;
  readonly version: string;
}): VercelConnectManifest | undefined {
  const requirements = new Map<string, VercelConnectManifestRequirement>();
  for (const connection of [
    input.manifest,
    ...input.manifest.subagents.map((node) => node.agent),
  ].flatMap((node) => node.connections)) {
    const requirement = connection.vercelConnectRequirement;
    if (requirement === undefined) continue;
    const existing = requirements.get(requirement.reference);
    const use = {
      kind: "connection" as const,
      logicalPath: connection.logicalPath,
      name: connection.connectionName,
    };
    const next = {
      ...requirement,
      resource: { protocol: connection.protocol, url: connection.url },
      uses: [...(existing?.uses ?? []), use],
    };
    requirements.set(requirement.reference, next);
  }
  return requirements.size === 0
    ? undefined
    : {
        kind: VERCEL_CONNECT_MANIFEST_KIND,
        schemaVersion: VERCEL_CONNECT_MANIFEST_VERSION,
        generator: { name: "eve", version: input.version },
        requirements: [...requirements.values()],
      };
}
