import type { RegistrySearchItem } from "#compiled/shadcn-registry/index.js";
import { createCliTheme, sanitizeForTerminal } from "#cli/ui/output.js";
import { clipVisible, wrapVisibleLine } from "#cli/ui/terminal-text.js";

import {
  parseRegistryPresentationManifest,
  type RegistrySearchMetadata,
} from "./registry-metadata.js";

export interface RegistrySearchPresentationItem extends RegistrySearchMetadata {
  address: string;
  item: RegistrySearchItem;
}

export interface RegistrySearchPresentationSection {
  label: string;
  items: RegistrySearchPresentationItem[];
  total: number;
}

export function normalizeRegistryText(value: string): string {
  return sanitizeForTerminal(value)
    .replaceAll('\\"', '"')
    .replaceAll("\\'", "'")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function registryDescriptionSummary(description: string): string {
  const normalized = normalizeRegistryText(description);
  return normalized.match(/^.*?[.!?](?=\s|$)/u)?.[0] ?? normalized;
}

function renderSearchItem(
  item: RegistrySearchPresentationItem,
  width: number,
  theme: ReturnType<typeof createCliTheme>,
): string {
  const valueWidth = Math.max(1, width - 4);
  const addressLines = wrapVisibleLine(normalizeRegistryText(item.address), valueWidth);
  const implementationLabel =
    item.implementation === "native"
      ? "First-class eve channel"
      : item.implementation === "chat-sdk"
        ? "Chat SDK adapter"
        : undefined;
  const name = normalizeRegistryText(item.item.name);
  const title = name.split("/").at(-1) ?? name;
  const lines = [
    `  ${theme.label(title)}${implementationLabel === undefined ? "" : theme.muted(` · ${implementationLabel}`)}`,
    ...addressLines.map((line) => `    ${line}`),
  ];
  if (!item.item.description) return lines.join("\n");

  const description = registryDescriptionSummary(item.item.description);
  if (description.length === 0) return lines.join("\n");

  const wrapped = wrapVisibleLine(description, valueWidth);
  const descriptionLines =
    wrapped.length <= 2
      ? wrapped
      : [wrapped[0]!, `${clipVisible(wrapped[1]!, Math.max(1, valueWidth - 1)).trimEnd()}…`];
  lines.push(...descriptionLines.map((line) => theme.muted(`    ${line}`)));
  return lines.join("\n");
}

export function printRegistrySearchResults(
  logger: { log(message: string): void },
  input: {
    json?: unknown;
    query: string | undefined;
    sections: readonly RegistrySearchPresentationSection[];
  },
): void {
  if (input.json !== undefined) {
    logger.log(JSON.stringify(input.json, null, 2));
    return;
  }
  if (input.sections.every((section) => section.items.length === 0)) {
    const query = input.query && normalizeRegistryText(input.query);
    logger.log(query ? `No registry items match "${query}".` : "No registry items found.");
    return;
  }

  const theme = createCliTheme();
  const width = Math.max(20, process.stdout.columns ?? 80);
  const rendered = input.sections.flatMap((section) => {
    if (section.items.length === 0) return [];
    const count = `${section.total} result${section.total === 1 ? "" : "s"}`;
    const detail =
      section.items.length < section.total ? `showing ${section.items.length} of ${count}` : count;
    const heading = `${theme.label(section.label)} ${theme.muted(`(${detail})`)}`;
    return [
      [heading, ...section.items.map((item) => renderSearchItem(item, width, theme))].join("\n"),
    ];
  });
  logger.log(rendered.join("\n"));
}

export function registryViewText(item: string, input: unknown): string {
  const manifest = parseRegistryPresentationManifest(input);
  if (manifest === undefined) return JSON.stringify(input, null, 2);

  const metadata = manifest.meta?.eve;
  const lines = [manifest.title ?? item, item];
  if (manifest.description !== undefined) lines.push("", manifest.description);
  if (metadata?.implementation !== undefined) {
    lines.push(
      "",
      `Implementation  ${metadata.implementation === "native" ? "First-class eve channel" : "Chat SDK adapter"}`,
    );
  }
  if (metadata?.setup !== undefined) lines.push("Setup           Guided setup");
  if (metadata?.docs !== undefined) {
    const docs = metadata.docs.startsWith("/") ? `https://eve.dev${metadata.docs}` : metadata.docs;
    lines.push(`Documentation   ${docs}`);
  }
  lines.push("Source          Official eve registry");
  if (manifest.dependencies?.length) {
    lines.push("", "Packages", ...manifest.dependencies.map((value) => `  ${value}`));
  }
  const files = manifest.files?.map((file) => file.target) ?? [];
  if (files.length > 0) lines.push("", "Files", ...files.map((value) => `  ${value}`));
  return lines.join("\n");
}
