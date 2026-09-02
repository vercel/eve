import {
  buildConnectionInstall,
  buildConnectionSetup,
  renderConnectionVariants,
} from "./connection-setup";
import { type Integration, integrations } from "./data";

const typeLabel: Record<Integration["type"], string> = {
  channel: "Channel",
  connection: "Connection",
  extension: "Extension",
  instrumentation: "Instrumentation",
  memory: "Memory provider",
};

const section = (title: string, content: string): string => `## ${title}\n\n${content}`;

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
  const setup = isConnection ? buildConnectionSetup(integration) : undefined;
  const install = isConnection ? buildConnectionInstall(integration) : (integration.install ?? "");
  const quickStart =
    integration.quickStart ?? (setup ? renderConnectionVariants(setup, setup.variants) : "");
  const configure =
    integration.configure ??
    (setup ? renderConnectionVariants(setup, setup.configureVariants) : "");

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
    "Browse eve integrations, including extensions, messaging channels, memory providers, and tool connections over MCP or OpenAPI.",
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
