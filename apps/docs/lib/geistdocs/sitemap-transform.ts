interface TemplateDiscoveryEntry {
  description: string;
  slug: string;
  title: string;
}

interface TransformSitemapOptions {
  resolveTitle: (title: string, url: string) => string;
  templates: TemplateDiscoveryEntry[];
}

const SITEMAP_ENTRY_PATTERN = /^(\s*)- \[([^\]]+)\]\(([^)]+)\) \| (.+)$/gm;

const machineTypeFor = (url: string): string | undefined => {
  if (
    url === "/docs/getting-started" ||
    url === "/docs/installation" ||
    url === "/docs/install-integrations" ||
    url.startsWith("/docs/guides/") ||
    url.startsWith("/docs/tutorial/")
  ) {
    return "How-to";
  }
  if (url.startsWith("/docs/reference/")) return "Reference";
  if (url.startsWith("/docs/concepts/") || url.startsWith("/docs/patterns/")) {
    return "Conceptual";
  }
};

const replaceType = (metadata: string, type: string | undefined): string =>
  type ? metadata.replace(/^Type: [^|]+?(?=\s*\||$)/, `Type: ${type}`) : metadata;

const addCanonical = (metadata: string, url: string): string =>
  metadata.includes("Canonical:") ? metadata : `${metadata} | Canonical: ${url}`;

export const transformSitemapMarkdown = (
  markdown: string,
  { resolveTitle, templates }: TransformSitemapOptions,
): string => {
  const transformed = markdown.replace(
    SITEMAP_ENTRY_PATTERN,
    (_match, indent: string, title: string, url: string, metadata: string) => {
      const resolvedTitle = resolveTitle(title, url);
      const typedMetadata = replaceType(metadata, machineTypeFor(url));
      return `${indent}- [${resolvedTitle}](${url}) | ${addCanonical(typedMetadata, url)}`;
    },
  );

  const templateLines = templates.map(
    (template) =>
      `- [${template.title}](/templates/${template.slug}) | Type: Example | Summary: ${template.description} | Canonical: /templates/${template.slug}`,
  );

  return `${transformed.trimEnd()}\n\n## Templates\n\n${templateLines.join("\n")}\n`;
};
