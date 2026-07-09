import {
  buildConnectionConfigure,
  buildConnectionInstall,
  buildConnectionSetup,
} from "./connection-setup";
import { authModeLabel, type AuthMode, type Integration, protocolLabel } from "./data";

/**
 * Serializes an integration detail page as standalone markdown — the same
 * content the HTML page renders, for `/integrations/<slug>.md`, AI-agent
 * markdown negotiation, and the Copy Markdown button.
 */
export const integrationMarkdown = (integration: Integration): string => {
  const isConnection = Boolean(integration.connection);
  const install = isConnection ? buildConnectionInstall(integration) : (integration.install ?? "");
  const configure = isConnection
    ? buildConnectionConfigure(integration)
    : (integration.configure ?? "");

  const facts = [`- Type: ${integration.type === "channel" ? "Channel" : "Connection"}`];
  const protocols = [...new Set((integration.surfaces ?? []).map((surface) => surface.protocol))];
  if (protocols.length > 0) {
    facts.push(`- Protocols: ${protocols.map((protocol) => protocolLabel[protocol]).join(", ")}`);
  }
  if (integration.logoDomain) {
    facts.push(`- Provider: ${integration.logoDomain}`);
  }
  facts.push(
    `- Source: ${integration.source === "generated" ? "Generated from public registries" : "Curated"}`,
  );

  const sections: string[] = [`# ${integration.name}`, integration.tagline, facts.join("\n")];

  const surfaces = integration.surfaces ?? [];
  if (surfaces.length > 0) {
    sections.push(
      "## Surfaces",
      surfaces
        .map(
          (surface) =>
            `- **${protocolLabel[surface.protocol]}** — ${surface.endpointLabel}: \`${surface.endpointValue}\` — Auth: ${surface.authLabels.join(", ")} (${surface.basisLabel})`,
        )
        .join("\n"),
    );
  }

  if (install) {
    sections.push("## Install", install);
  }

  if (isConnection) {
    const setup = buildConnectionSetup(integration);
    const variantSections: string[] = [];
    for (const surface of setup.surfaces) {
      for (const auth of surface.authModes) {
        const variant = setup.variants[`${surface.protocol}:${auth}`];
        if (variant) {
          variantSections.push(
            `### ${surface.label} — ${authModeLabel[auth as AuthMode]}`,
            variant,
          );
        }
      }
    }
    if (variantSections.length > 0) {
      sections.push("## Quick start", ...variantSections);
    }
  } else if (integration.quickStart) {
    sections.push("## Quick start", integration.quickStart);
  }

  if (configure) {
    sections.push("## Configure", configure);
  }

  return `${sections.join("\n\n")}\n`;
};
