import {
  buildConnectionConfigure,
  buildConnectionInstall,
  buildConnectionSetup,
} from "./connection-setup";
import { type Integration, authModeLabel, integrations, protocolLabel } from "./data";

const typeLabel: Record<Integration["type"], string> = {
  channel: "Channel",
  connection: "Connection",
  extension: "Extension",
};

const section = (title: string, content: string): string => `## ${title}\n\n${content}`;

const connectionQuickStart = (integration: Integration): string => {
  const setup = buildConnectionSetup(integration);

  return setup.protocols
    .flatMap((protocol) =>
      setup.authModes.map((authMode) => {
        const content = setup.variants[`${protocol}:${authMode}`] ?? "";
        return `### ${protocolLabel[protocol]} · ${authModeLabel[authMode]}\n\n${content}`;
      }),
    )
    .join("\n\n");
};

/** Plain text used by the advanced search index for one integration. */
export const integrationSearchText = (integration: Integration): string =>
  [
    integration.name,
    typeLabel[integration.type],
    integration.tagline,
    ...(integration.keywords ?? []),
  ].join("\n");

/** Markdown representation shared by integration discovery and agent-readable routes. */
export const integrationMarkdown = (integration: Integration): string => {
  const isConnection = integration.connection !== undefined;
  const install = isConnection ? buildConnectionInstall(integration) : (integration.install ?? "");
  const quickStart = isConnection
    ? connectionQuickStart(integration)
    : (integration.quickStart ?? "");
  const configure = isConnection
    ? buildConnectionConfigure(integration)
    : (integration.configure ?? "");

  return [
    `${typeLabel[integration.type]} integration for eve. ${integration.tagline}`,
    section("Install", install),
    section("Quick start", quickStart),
    section("Configure", configure),
    `[Read the full ${typeLabel[integration.type].toLowerCase()} documentation](${integration.docsHref})`,
  ].join("\n\n");
};

/** Markdown landing page for agent-readable integration discovery. */
export const integrationsIndexMarkdown = (): string =>
  [
    "Browse every third-party service eve connects to, including extensions, messaging channels, and tool connections over MCP or OpenAPI.",
    ...integrations.map(
      (integration) =>
        `- [${integration.name}](/integrations/${integration.slug}): ${integration.tagline}`,
    ),
  ].join("\n\n");

/** Public integration paths included in crawler-facing sitemaps. */
export const integrationPaths = (): string[] => [
  "/integrations",
  ...integrations.map((integration) => `/integrations/${integration.slug}`),
];
