import type { RegistrySearchItem } from "#compiled/shadcn-registry/index.js";
import { createCliTheme, sanitizeForTerminal } from "#cli/ui/output.js";
import { clipVisible, wrapVisibleLine } from "#cli/ui/terminal-text.js";

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
  item: RegistrySearchItem,
  address: string,
  width: number,
  theme: ReturnType<typeof createCliTheme>,
): string {
  const valueWidth = Math.max(1, width - 4);
  const addressLines = wrapVisibleLine(normalizeRegistryText(address), valueWidth);
  const name = normalizeRegistryText(item.name);
  const title = name.split("/").at(-1) ?? name;
  const lines = [`  ${theme.label(title)}`, ...addressLines.map((line) => `    ${line}`)];
  if (!item.description) return lines.join("\n");

  const description = registryDescriptionSummary(item.description);
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
  result: { items: RegistrySearchItem[] },
  options: {
    json?: boolean;
    query: string | undefined;
    sections: readonly {
      label: string;
      items: RegistrySearchItem[];
      total: number;
      address(item: RegistrySearchItem): string;
    }[];
  },
): void {
  if (options.json) {
    logger.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.items.length === 0) {
    const query = options.query && normalizeRegistryText(options.query);
    logger.log(query ? `No registry items match "${query}".` : "No registry items found.");
    return;
  }

  const theme = createCliTheme();
  const width = Math.max(20, process.stdout.columns ?? 80);
  const sections = options.sections.flatMap((section) => {
    if (section.items.length === 0) return [];
    const count = `${section.total} result${section.total === 1 ? "" : "s"}`;
    const detail =
      section.items.length < section.total ? `showing ${section.items.length} of ${count}` : count;
    const heading = `${theme.label(section.label)} ${theme.muted(`(${detail})`)}`;
    return [
      [
        heading,
        ...section.items.map((item) => renderSearchItem(item, section.address(item), width, theme)),
      ].join("\n"),
    ];
  });
  logger.log(sections.join("\n"));
}
