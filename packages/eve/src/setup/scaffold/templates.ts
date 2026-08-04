// Generated from src/setup/scaffold/templates/source by eve's setup build (src/setup/build.ts).
// Do not edit directly. Run `pnpm --filter eve generate:web-template`.

export const SCAFFOLD_TEMPLATE_SOURCES = {
  "channels/photon/connect":
    'import { connectPhotonCredentials } from "@vercel/connect/eve";\nimport { photonIMessageChannel } from "eve/channels/photon";\n\nexport default photonIMessageChannel({\n  credentials: connectPhotonCredentials(__EVE_CONNECTOR_UID__),\n});\n',
  "channels/photon/environment":
    'import { photonIMessageChannel } from "eve/channels/photon";\n\nasync function photonCredentials() {\n  const projectId = process.env.IMESSAGE_PROJECT_ID;\n  const projectSecret = process.env.IMESSAGE_PROJECT_SECRET;\n  if (!projectId || !projectSecret) throw new Error("Photon project credentials are required.");\n  return { projectId, projectSecret };\n}\n\nexport default photonIMessageChannel({\n  credentials: photonCredentials,\n  webhookSecret: process.env.IMESSAGE_WEBHOOK_SECRET,\n});\n',
  "channels/slack/connect":
    'import { connectSlackCredentials } from "@vercel/connect/eve";\nimport { slackChannel } from "eve/channels/slack";\n\nexport default slackChannel({\n  credentials: connectSlackCredentials(__EVE_CONNECTOR_UID__),\n});\n',
  "channels/slack/environment":
    'import { slackChannel } from "eve/channels/slack";\n\nexport default slackChannel();\n',
  "connections/mcp/bearer-env":
    'import { defineMcpClientConnection } from "eve/connections";\n\nexport default defineMcpClientConnection({\n  url: __EVE_CONNECTION_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n  auth: { getToken: async () => ({ token: __EVE_BEARER_TOKEN__ }) },\n});\n',
  "connections/mcp/connect":
    'import { connect } from "@vercel/connect/eve";\nimport { defineMcpClientConnection } from "eve/connections";\n\nexport default defineMcpClientConnection({\n  url: __EVE_CONNECTION_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n  auth: connect(__EVE_CONNECTOR_UID__),\n});\n',
  "connections/mcp/headers":
    'import { defineMcpClientConnection } from "eve/connections";\n\nexport default defineMcpClientConnection({\n  url: __EVE_CONNECTION_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n  headers: () => __EVE_HEADERS__,\n});\n',
  "connections/mcp/none":
    'import { defineMcpClientConnection } from "eve/connections";\n\nexport default defineMcpClientConnection({\n  url: __EVE_CONNECTION_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n});\n',
  "connections/openapi/bearer-env":
    'import { defineOpenAPIConnection } from "eve/connections";\n\nexport default defineOpenAPIConnection({\n  spec: __EVE_OPENAPI_SPEC__,\n  baseUrl: __EVE_OPENAPI_BASE_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n  auth: { getToken: async () => ({ token: __EVE_BEARER_TOKEN__ }) },\n});\n',
  "connections/openapi/connect":
    'import { connect } from "@vercel/connect/eve";\nimport { defineOpenAPIConnection } from "eve/connections";\n\nexport default defineOpenAPIConnection({\n  spec: __EVE_OPENAPI_SPEC__,\n  baseUrl: __EVE_OPENAPI_BASE_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n  auth: connect(__EVE_CONNECTOR_UID__),\n});\n',
  "connections/openapi/headers":
    'import { defineOpenAPIConnection } from "eve/connections";\n\nexport default defineOpenAPIConnection({\n  spec: __EVE_OPENAPI_SPEC__,\n  baseUrl: __EVE_OPENAPI_BASE_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n  headers: () => __EVE_HEADERS__,\n});\n',
  "connections/openapi/none":
    'import { defineOpenAPIConnection } from "eve/connections";\n\nexport default defineOpenAPIConnection({\n  spec: __EVE_OPENAPI_SPEC__,\n  baseUrl: __EVE_OPENAPI_BASE_URL__,\n  description: __EVE_CONNECTION_DESCRIPTION__,\n});\n',
} as const;

export type ScaffoldTemplateId = keyof typeof SCAFFOLD_TEMPLATE_SOURCES;
