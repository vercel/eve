import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { isJsonObjectValue, parseJsonObject, type JsonObject } from "#shared/json.js";

export const VERCEL_CONNECT_MANIFEST_FILENAME = "vercel-connect-manifest.json";
export const VERCEL_CONNECT_MANIFEST_KIND = "vercel-connect-manifest";
export const VERCEL_CONNECT_MANIFEST_SCHEMA_VERSION = 1;

const RFC_7591_MANIFEST_TYPE = "https://datatracker.ietf.org/doc/html/rfc7591";
const SLACK_API_URL = "https://docs.slack.dev/apis/web-api/";
const SLACK_MANIFEST_TYPE = "https://docs.slack.dev/reference/app-manifest/";
const VERCEL_CONNECT_CALLBACK_URL = "https://connect.vercel.com/callback";
const VERCEL_CONNECT_TRIGGER_URL = "https://connect.vercel.com/trigger?path=";

export type VercelConnectInterface =
  | { readonly protocol: "mcp" | "openapi"; readonly url: string }
  | { readonly npm: string; readonly protocol: "custom"; readonly url: string };

export interface VercelConnectRequirement {
  readonly target: string;
  readonly interfaces: readonly VercelConnectInterface[];
  readonly connect: {
    readonly subjectTypes: readonly ("app" | "user")[];
    readonly service: string;
    readonly type: string;
    readonly manifest: JsonObject;
  };
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
      "adapterKind" | "logicalPath" | "name" | "slackAppManifest" | "urlPath" | "vercelConnect"
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
          target: vercelConnect.connector,
          interfaces: [{ protocol: connection.protocol, url: connection.url }],
          connect: {
            subjectTypes: vercelConnect.principalTypes,
            service: connectService(vercelConnect.connector, vercelConnect.connectorType),
            type: vercelConnect.connectorType,
            manifest: { $type: RFC_7591_MANIFEST_TYPE },
          },
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
        vercelConnect?.connectorType !== "slack" ||
        vercelConnect.principalTypes === undefined ||
        channel.adapterKind !== "slack" ||
        channel.slackAppManifest === undefined
      ) {
        return [];
      }
      return [
        {
          target: vercelConnect.connector,
          interfaces: [{ protocol: "custom" as const, url: SLACK_API_URL, npm: "@slack/web-api" }],
          connect: {
            subjectTypes: vercelConnect.principalTypes,
            service: "slack",
            type: vercelConnect.connectorType,
            manifest: buildConnectSlackManifest(channel.slackAppManifest, channel.urlPath),
          },
          uses: [
            { kind: "channel" as const, name: channel.name, logicalPath: channel.logicalPath },
          ],
        },
      ];
    }),
  ];
}

function buildConnectSlackManifest(manifest: JsonObject, triggerPath: string): JsonObject {
  const copy = parseJsonObject(manifest);
  const oauthConfig = objectValue(copy.oauth_config);
  const settings = objectValue(copy.settings);
  const eventSubscriptions = objectValue(settings.event_subscriptions);
  const interactivity = objectValue(settings.interactivity);
  const requestUrl = `${VERCEL_CONNECT_TRIGGER_URL}${triggerPath}`;

  return {
    ...copy,
    $type: SLACK_MANIFEST_TYPE,
    oauth_config: {
      ...oauthConfig,
      redirect_urls: [VERCEL_CONNECT_CALLBACK_URL],
    },
    settings: {
      ...settings,
      event_subscriptions: { ...eventSubscriptions, request_url: requestUrl },
      interactivity: { ...interactivity, request_url: requestUrl },
    },
  };
}

function objectValue(value: JsonObject[string] | undefined): JsonObject {
  return isJsonObjectValue(value) ? value : {};
}

function connectService(connector: string, connectorType: string): string {
  if (connectorType === "slack") return "slack";
  return connector.split("/").at(-1) ?? connector;
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
  if (connectManifest === undefined) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(input.outputDirectory, { recursive: true });
  await writeFile(
    join(input.outputDirectory, VERCEL_CONNECT_MANIFEST_FILENAME),
    `${JSON.stringify(connectManifest, null, 2)}\n`,
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
