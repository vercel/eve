import type { Integration } from "./data";

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
