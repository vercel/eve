import type { CompiledAgentManifest } from "#compiler/manifest.js";
import type { JsonObject } from "#shared/json.js";

export const VERCEL_CONNECT_MANIFEST_FILENAME = "vercel-connect-manifest.json";
export const VERCEL_CONNECT_MANIFEST_KIND = "vercel-connect-manifest";
export const VERCEL_CONNECT_MANIFEST_SCHEMA_VERSION = 1;
export const SLACK_APP_MANIFEST_FORMAT = "slack-app-manifest";

export interface SlackAppManifest {
  readonly display_information: { readonly name: string };
  readonly features: {
    readonly app_home: {
      readonly home_tab_enabled: false;
      readonly messages_tab_enabled: true;
      readonly messages_tab_read_only_enabled: false;
    };
    readonly bot_user: { readonly display_name: string; readonly always_online: false };
  };
  readonly oauth_config: { readonly scopes: { readonly bot: readonly string[] } };
  readonly settings: {
    readonly event_subscriptions: { readonly bot_events: readonly string[] };
    readonly interactivity: { readonly is_enabled: true };
    readonly org_deploy_enabled: false;
    readonly socket_mode_enabled: false;
    readonly token_rotation_enabled: false;
  };
}

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
      const providerConfiguration =
        vercelConnect.connectorType === "slack"
          ? {
              format: SLACK_APP_MANIFEST_FORMAT,
              path: slackAppManifestPath(channel.logicalPath),
            }
          : undefined;
      const requirement = {
        target: { mode: "direct" as const, locator: vercelConnect.connector },
        connector: { type: vercelConnect.connectorType },
        access: { principalTypes: vercelConnect.principalTypes },
        triggers: [{ method: channel.method, path: channel.urlPath }],
        uses: [{ kind: "channel" as const, name: channel.name, logicalPath: channel.logicalPath }],
      };
      return [
        providerConfiguration === undefined
          ? requirement
          : { ...requirement, providerConfiguration },
      ];
    }),
  ];
}

export async function emitVercelConnectManifest(input: {
  readonly generatorVersion: string;
  readonly manifest: CompiledAgentManifest;
  readonly outputDirectory: string;
}): Promise<void> {
  const connectManifest = createVercelConnectManifest({
    generatorVersion: input.generatorVersion,
    requirements: buildVercelConnectRequirements(input.manifest),
  });
  const slackManifests = buildSlackAppManifests(input.manifest);
  if (connectManifest === undefined && slackManifests.size === 0) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  await mkdir(input.outputDirectory, { recursive: true });
  if (connectManifest !== undefined) {
    await writeFile(
      join(input.outputDirectory, VERCEL_CONNECT_MANIFEST_FILENAME),
      `${JSON.stringify(connectManifest, null, 2)}\n`,
    );
  }
  for (const [path, slackManifest] of slackManifests) {
    const outputPath = join(input.outputDirectory, path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(slackManifest, null, 2)}\n`);
  }
}

export function buildSlackAppManifests(manifest: {
  readonly channelRoutes: {
    readonly effective: readonly Pick<
      CompiledAgentManifest["channelRoutes"]["effective"][number],
      "adapterKind" | "logicalPath" | "name" | "slackAppManifest"
    >[];
  };
}): ReadonlyMap<string, SlackAppManifest> {
  const manifests = new Map<string, SlackAppManifest>();
  for (const channel of manifest.channelRoutes.effective) {
    if (channel.adapterKind !== "slack") continue;
    const name = (channel.slackAppManifest?.displayName ?? channel.name).slice(0, 35);
    manifests.set(slackAppManifestPath(channel.logicalPath), {
      display_information: { name },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: name, always_online: false },
      },
      oauth_config: {
        scopes: {
          bot: unique(["app_mentions:read", "chat:write"], channel.slackAppManifest?.botScopes),
        },
      },
      settings: {
        event_subscriptions: {
          bot_events: unique(["app_mention"], channel.slackAppManifest?.botEvents),
        },
        interactivity: { is_enabled: true },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    });
  }
  return manifests;
}

export function slackAppManifestPath(logicalPath: string): string {
  return `${logicalPath.replace(/\.[^/.]+$/, "")}.slack-app-manifest.json`;
}

function unique(
  baseline: readonly string[],
  additional: readonly string[] = [],
): readonly string[] {
  return [...new Set([...baseline, ...additional])];
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
