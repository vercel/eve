import { type Integration, integrations } from "./data";

const typeLabel: Record<Integration["type"], string> = {
  channel: "Channel",
  connection: "Connection",
  extension: "Extension",
};

/** Plain text used by the advanced search index for one integration. */
export const integrationSearchText = (integration: Integration): string =>
  [
    integration.name,
    typeLabel[integration.type],
    integration.tagline,
    ...(integration.keywords ?? []),
  ].join("\n");

/** Public integration paths included in crawler-facing sitemaps. */
export const integrationPaths = (): string[] => [
  "/integrations",
  ...integrations.map((integration) => `/integrations/${integration.slug}`),
];
